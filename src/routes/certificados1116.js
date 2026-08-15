const router = require('express').Router();
const { pool } = require('../db');
const { registrarAuditoria } = require('../services/auditoria');
const { generateTraceProposals, listTraceLinks, reviewTraceLink } = require('../services/arcaTraceability');

// GET /api/certificados-1116 - listado, mas reciente primero, con sus CTGs
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, cp.razon_social as productor_nombre_cp, e.nombre as especie_nombre, ca.descripcion as campana_desc
      FROM certificados_1116 c
      LEFT JOIN contrapartes cp ON cp.cuit = c.cuit_productor
      LEFT JOIN especies e ON c.id_especie = e.id
      LEFT JOIN campanas ca ON c.id_campana = ca.id
      ORDER BY c.fecha_emision DESC NULLS LAST, c.id DESC
    `);

    const { rows: ctgs } = await pool.query(`
      SELECT cc.id_certificado_1116, cc.nro_ctg, cc.id_movimiento, m.numero_movimiento
      FROM certificado_1116_ctgs cc
      LEFT JOIN movimientos m ON cc.id_movimiento = m.id
    `);
    const ctgsPorCertificado = {};
    for (const c of ctgs) {
      (ctgsPorCertificado[c.id_certificado_1116] = ctgsPorCertificado[c.id_certificado_1116] || []).push({
        nro_ctg: c.nro_ctg, id_movimiento: c.id_movimiento, numero_movimiento: c.numero_movimiento
      });
    }

    res.json(rows.map(r => ({ ...r, ctgs: ctgsPorCertificado[r.id] || [] })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/certificados-1116 - carga manual (a partir de un PDF real que ya
// tiene la empresa, ya que ARCA no permite listarlos automaticamente cuando
// los emite un corredor). Acepta hasta 20 CTG por certificado, porque un
// mismo certificado de deposito puede consolidar varias entregas/camiones.
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      tipo_formulario, numero_certificado, coe, cuit_productor, nombre_productor,
      id_especie, id_campana, kilos_netos, fecha_emision, ctgs,
      id_retiro_productor, direccion, observaciones
    } = req.body;

    if (!tipo_formulario || !['A', 'B', 'C'].includes(tipo_formulario.toUpperCase())) {
      return res.status(400).json({ error: 'tipo_formulario debe ser A, B o C' });
    }
    if (!coe) return res.status(400).json({ error: 'El C.O.E. es obligatorio' });

    const ctgsLimpios = (Array.isArray(ctgs) ? ctgs : [])
      .map(c => (c || '').trim())
      .filter(Boolean)
      .slice(0, 20);

    await client.query('BEGIN');

    const { rows: existe } = await client.query('SELECT id, numero_certificado FROM certificados_1116 WHERE coe = $1', [coe]);
    if (existe.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Ya existe un certificado con ese C.O.E. (id ${existe[0].id})` });
    }

    // Vinculacion automatica al primer CTG cargado, solo para no perder el
    // campo id_movimiento historico de la tabla -- el detalle real de
    // vinculacion por CTG vive en certificado_1116_ctgs.
    let idMovimientoPrincipal = null;
    if (ctgsLimpios[0]) {
      const { rows: movRows } = await client.query('SELECT id FROM movimientos WHERE nro_ctg = $1 LIMIT 1', [ctgsLimpios[0]]);
      if (movRows[0]) idMovimientoPrincipal = movRows[0].id;
    }

    const { rows } = await client.query(`
      INSERT INTO certificados_1116
        (tipo_formulario, numero_certificado, coe, cuit_productor, nombre_productor,
         id_especie, id_campana, kilos_netos, fecha_emision, nro_ctg_asociado,
         id_movimiento, id_retiro_productor, direccion, origen_carga)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'MANUAL')
      RETURNING *
    `, [
      tipo_formulario.toUpperCase(), numero_certificado || null, coe, cuit_productor || null, nombre_productor || null,
      id_especie || null, id_campana || null, kilos_netos || null, fecha_emision || null, ctgsLimpios[0] || null,
      idMovimientoPrincipal, id_retiro_productor || null, direccion || null
    ]);
    const certificado = rows[0];

    const ctgsGuardados = [];
    for (const ctg of ctgsLimpios) {
      const { rows: movRows } = await client.query('SELECT id, numero_movimiento FROM movimientos WHERE nro_ctg = $1 LIMIT 1', [ctg]);
      const idMov = movRows[0] ? movRows[0].id : null;
      await client.query(
        'INSERT INTO certificado_1116_ctgs (id_certificado_1116, nro_ctg, id_movimiento) VALUES ($1,$2,$3)',
        [certificado.id, ctg, idMov]
      );
      ctgsGuardados.push({ nro_ctg: ctg, id_movimiento: idMov, numero_movimiento: movRows[0] ? movRows[0].numero_movimiento : null });
    }

    await registrarAuditoria(req, { accion: 'CREAR', modulo: 'certificados_1116', registro_id: certificado.id, datos_despues: { ...certificado, ctgs: ctgsGuardados } });
    await client.query('COMMIT');
    res.status(201).json({ ...certificado, ctgs: ctgsGuardados });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/certificados-1116/importar-inventario-arca
// Importa exclusivamente metadatos previamente consultados en ARCA. Es idempotente por COE
// y no ejecuta ninguna operacion fiscal. Los campos aun no disponibles quedan nulos para
// enriquecimiento posterior por PDF/detalle oficial y revision humana.
router.post('/importar-inventario-arca', async (req, res) => {
  const client = await pool.connect();
  try {
    const documentos = Array.isArray(req.body.documentos) ? req.body.documentos : [];
    if (!documentos.length) return res.status(400).json({ error: 'documentos debe contener al menos un registro' });
    if (documentos.length > 1000) return res.status(400).json({ error: 'El lote no puede superar 1000 documentos' });

    const normalizados = documentos.map((d, indice) => {
      const coe = String(d.coe || '').replace(/\D/g, '');
      const tipo = String(d.tipo_formulario || 'A').trim().toUpperCase();
      const cuit = String(d.cuit_productor || '').replace(/\D/g, '');
      if (!/^\d{8,20}$/.test(coe)) throw new Error(`COE invalido en fila ${indice + 1}`);
      if (!['A', 'B', 'C'].includes(tipo)) throw new Error(`tipo_formulario invalido en fila ${indice + 1}`);
      if (cuit && !/^\d{11}$/.test(cuit)) throw new Error(`CUIT invalido en fila ${indice + 1}`);
      const fecha = d.fecha_emision ? new Date(d.fecha_emision) : null;
      if (fecha && Number.isNaN(fecha.getTime())) throw new Error(`fecha_emision invalida en fila ${indice + 1}`);
      return {
        coe,
        tipo,
        numero: String(d.numero_certificado || '').trim() || null,
        cuit: cuit || null,
        nombre: String(d.nombre_productor || '').trim() || null,
        fecha,
        direccion: String(d.direccion || '').trim().slice(0, 80) || null
      };
    });

    const unicos = [...new Map(normalizados.map(d => [d.coe, d])).values()];
    await client.query('BEGIN');
    let creados = 0;
    let existentes = 0;

    for (const d of unicos) {
      const previo = await client.query('SELECT id FROM certificados_1116 WHERE coe = $1 LIMIT 1', [d.coe]);
      if (previo.rows[0]) {
        existentes += 1;
        continue;
      }
      await client.query(`
        INSERT INTO certificados_1116
          (tipo_formulario, numero_certificado, coe, cuit_productor, nombre_productor,
           fecha_emision, direccion, origen_carga)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'INVENTARIO_ARCA')
      `, [d.tipo, d.numero, d.coe, d.cuit, d.nombre, d.fecha, d.direccion]);
      creados += 1;
    }

    await client.query('COMMIT');
    const resultado = {
      recibidos: documentos.length,
      unicos: unicos.length,
      creados,
      existentes,
      duplicados_en_lote: documentos.length - unicos.length,
      pendientes_enriquecimiento: creados
    };
    await registrarAuditoria(req, {
      accion: 'IMPORTAR_INVENTARIO',
      modulo: 'certificados_1116',
      datos_despues: resultado
    });
    res.json({ ok: true, resultado, soloConsultaArca: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/certificados-1116/trazabilidad/generar - solo genera evidencia y propuestas internas.
// No emite, anula ni modifica documentos fiscales en ARCA.
router.post('/trazabilidad/generar', async (req, res) => {
  try {
    const result = await generateTraceProposals();
    await registrarAuditoria(req, { accion: 'GENERAR_PROPUESTAS', modulo: 'arca_trazabilidad', datos_despues: result });
    res.json({ ok: true, resultado: result, soloConsulta: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/certificados-1116/trazabilidad?certificado_id=123
router.get('/trazabilidad', async (req, res) => {
  try {
    const certificateId = req.query.certificado_id ? Number(req.query.certificado_id) : null;
    if (req.query.certificado_id && !Number.isInteger(certificateId)) return res.status(400).json({ error: 'certificado_id inválido' });
    res.json({ ok: true, vinculos: await listTraceLinks(certificateId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/certificados-1116/trazabilidad/:id/revisar
router.post('/trazabilidad/:id/revisar', async (req, res) => {
  try {
    const estado = String(req.body.estado || '').toUpperCase();
    const link = await reviewTraceLink(req.params.id, estado, req.user?.id || null);
    await registrarAuditoria(req, { accion: estado, modulo: 'arca_trazabilidad', registro_id: link.id, datos_despues: link });
    res.json({ ok: true, vinculo: link });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/certificados-1116/:id - por si se cargo mal (borra en cascada sus CTGs)
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM certificados_1116 WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
    await pool.query('DELETE FROM certificados_1116 WHERE id = $1', [req.params.id]);
    await registrarAuditoria(req, { accion: 'ELIMINAR', modulo: 'certificados_1116', registro_id: rows[0].id, datos_antes: rows[0] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
