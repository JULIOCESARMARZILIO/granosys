// cuentacorriente.js
const router = require('express').Router();
const { pool } = require('../db');

router.get('/contrapartes/:id', async (req, res) => {
  try {
    const { modalidad } = req.query;
    const params = [req.params.id];
    let where = 'cc.id_contraparte = $1';
    if (modalidad) { params.push(modalidad); where += ` AND cc.modalidad = $${params.length}`; }
    const { rows } = await pool.query(`
      SELECT cc.*, l.nro_liquidacion, c.numero_contrato,
             op.numero AS numero_orden_pago, op.clase_pago, op.estado AS estado_orden_pago,
             op.importe_total AS importe_orden_pago, op.fecha_pago AS fecha_pago_orden,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'id', mt.id,
                 'medio_pago', mt.medio_pago,
                 'importe', mt.importe,
                 'cuenta_bancaria', cb.nombre,
                 'cheque_id', ch.id,
                 'cheque_tipo', ch.tipo,
                 'cheque_numero', ch.numero,
                 'cheque_banco', ch.banco,
                 'cheque_fecha_pago', ch.fecha_pago,
                 'cheque_estado', ch.estado,
                 'cruzado', ch.cruzado
               ) ORDER BY mt.id)
               FROM movimientos_tesoreria mt
               LEFT JOIN cuentas_bancarias cb ON cb.id=mt.id_cuenta_bancaria
               LEFT JOIN cheques_tesoreria ch ON ch.id_movimiento_tesoreria=mt.id
               WHERE mt.id_orden_pago=op.id
             ), '[]'::jsonb) AS instrumentos_pago
      FROM cc_contrapartes cc
      LEFT JOIN liquidaciones l ON cc.id_liquidacion = l.id
      LEFT JOIN contratos c ON cc.id_contrato = c.id
      LEFT JOIN ordenes_pago op ON op.id=cc.id_orden_pago
      WHERE ${where}
      ORDER BY cc.fecha DESC, cc.id DESC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ?modalidad=FORMAL|INFORMAL -- sin este filtro se mezclaban los saldos de
// los dos circuitos en un solo numero, que es exactamente lo que NO se
// quiere ver parado en el modulo Formal o el Informal (para eso esta la
// vista Consolidada aparte, que si suma todo a proposito).
router.get('/resumen', async (req, res) => {
  try {
    const { modalidad } = req.query;
    const params = [];
    let joinCond = 'cp.id = cc.id_contraparte';
    if (modalidad) { params.push(modalidad); joinCond += ` AND cc.modalidad = $${params.length}`; }
    const { rows } = await pool.query(`
      SELECT cp.id, cp.razon_social, cp.tipo_contraparte, cp.cuit,
             COALESCE(SUM(cc.debe - cc.haber), 0) as saldo,
             COUNT(CASE WHEN cc.estado = 'ABIERTO' THEN 1 END) as movs_pendientes
      FROM contrapartes cp
      LEFT JOIN cc_contrapartes cc ON ${joinCond}
      WHERE cp.activo = TRUE
      GROUP BY cp.id, cp.razon_social, cp.tipo_contraparte, cp.cuit
      HAVING COUNT(cc.id) > 0
      ORDER BY ABS(COALESCE(SUM(cc.debe - cc.haber), 0)) DESC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /consolidado - agrupa y suma saldos de contrapartes relacionadas o con mismo CUIT
router.get('/consolidado', async (req, res) => {
  try {
    // 1. Obtener todas las contrapartes activas
    const { rows: cps } = await pool.query('SELECT * FROM contrapartes WHERE activo = true');
    
    // 2. Obtener saldos de la cc agrupados por id_contraparte y modalidad
    const { rows: saldos } = await pool.query(`
      SELECT id_contraparte, modalidad, COALESCE(SUM(debe - haber), 0) as saldo
      FROM cc_contrapartes
      GROUP BY id_contraparte, modalidad
    `);

    // Organizar saldos por id_contraparte
    const saldosMap = {};
    saldos.forEach(s => {
      const cid = s.id_contraparte;
      if (!saldosMap[cid]) {
        saldosMap[cid] = { FORMAL: 0, INFORMAL: 0 };
      }
      if (s.modalidad === 'FORMAL') {
        saldosMap[cid].FORMAL += parseFloat(s.saldo);
      } else {
        saldosMap[cid].INFORMAL += parseFloat(s.saldo);
      }
    });

    // Mapeo de CUIT a id de contraparte FORMAL/AMBOS principal
    const cuitToFormalId = {};
    cps.forEach(cp => {
      if (cp.cuit && cp.cuit.trim() !== '' && (cp.canal_operacion === 'FORMAL' || cp.canal_operacion === 'AMBOS')) {
        cuitToFormalId[cp.cuit.trim()] = cp.id;
      }
    });

    // Mapeo para agrupar
    const grupos = {}; // grupo_id => { nombre, tipo, f: 0, i: 0 }

    cps.forEach(cp => {
      let grupoId = cp.id;
      if (cp.id_contraparte_relacionada) {
        grupoId = cp.id_contraparte_relacionada;
      } else if (cp.cuit && cp.cuit.trim() !== '' && cuitToFormalId[cp.cuit.trim()]) {
        grupoId = cuitToFormalId[cp.cuit.trim()];
      }

      // Asegurar que el grupoId exista
      if (!grupos[grupoId]) {
        const grupoCp = cps.find(c => c.id === grupoId) || cp;
        grupos[grupoId] = {
          id: grupoId,
          nombre: grupoCp.razon_social,
          tipo: grupoCp.tipo_contraparte,
          f: 0,
          i: 0
        };
      }

      // Sumar saldos de esta contraparte a su grupo
      const cpSaldos = saldosMap[cp.id] || { FORMAL: 0, INFORMAL: 0 };
      grupos[grupoId].f += cpSaldos.FORMAL;
      grupos[grupoId].i += cpSaldos.INFORMAL;
    });

    // Convertir a array y filtrar los que tienen saldo
    const result = Object.values(grupos).map(g => ({
      ...g,
      f: Math.round(g.f * 100) / 100,
      i: Math.round(g.i * 100) / 100
    })).filter(g => g.f !== 0 || g.i !== 0);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


router.post('/movimientos', async (req, res) => {
  res.status(405).json({
    error: 'Cuenta Corriente es de solo consulta. Registre el pago mediante una Orden de Pago en Tesoreria.'
  });
});

router.put('/movimientos/:id/asignar', async (req, res) => {
  try {
    const { id } = req.params;
    const { id_liquidacion } = req.body;

    if (!id_liquidacion) {
      return res.status(400).json({ error: "Debe especificar la liquidación a la cual asignar el pago" });
    }

    // Verificar que la liquidación exista
    const { rows: liq } = await pool.query("SELECT id, nro_liquidacion FROM liquidaciones WHERE id = $1", [id_liquidacion]);
    if (liq.length === 0) {
      return res.status(404).json({ error: "Liquidación no encontrada" });
    }

    // Actualizar el movimiento de cuenta corriente
    const { rows } = await pool.query(`
      UPDATE cc_contrapartes
      SET id_liquidacion = $1,
          concepto = CONCAT(concepto, ' (Imputado a ', $2::text, ')')
      WHERE id = $3
      RETURNING *
    `, [id_liquidacion, liq[0].nro_liquidacion, id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: "Movimiento de cuenta corriente no encontrado" });
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /transportistas/resumen - Resumen de cuentas corrientes de transportistas
router.get('/transportistas/resumen', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id,
             t.razon_social as nombre,
             COALESCE((SELECT SUM(cc.debe - cc.haber) FROM cc_transportistas cc WHERE cc.id_transportista = t.id), 0) as saldo,
             COALESCE((SELECT COUNT(*) FROM cc_transportistas cc WHERE cc.id_transportista = t.id AND cc.estado = 'ABIERTO'), 0) as fletes,
             COALESCE((SELECT SUM(m.faltante_kg) FROM movimientos m WHERE m.id_transportista = t.id), 0) as faltantes
      FROM transportistas t
      WHERE t.activo = TRUE
      ORDER BY t.razon_social ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /transportistas/:id - Detalle de movimientos de cuenta corriente de un transportista
router.get('/transportistas/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT cc.*
      FROM cc_transportistas cc
      WHERE cc.id_transportista = $1
      ORDER BY cc.fecha DESC, cc.id DESC
    `, [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /transportistas/movimientos - Registrar pago o adelanto a un transportista
router.post('/transportistas/movimientos', async (req, res) => {
  res.status(405).json({
    error: 'Cuenta Corriente es de solo consulta. Registre el pago mediante una Orden de Pago en Tesoreria.'
  });
});

module.exports = router;
