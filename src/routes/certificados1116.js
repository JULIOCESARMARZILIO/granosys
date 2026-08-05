const router = require('express').Router();
const { pool } = require('../db');
const { registrarAuditoria } = require('../services/auditoria');

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
