// cuentacorriente.js
const router = require('express').Router();
const { pool } = require('../db');

router.get('/contrapartes/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT cc.*, l.nro_liquidacion, c.numero_contrato
      FROM cc_contrapartes cc
      LEFT JOIN liquidaciones l ON cc.id_liquidacion = l.id
      LEFT JOIN contratos c ON cc.id_contrato = c.id
      WHERE cc.id_contraparte = $1
      ORDER BY cc.fecha DESC, cc.id DESC
    `, [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/resumen', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT cp.id, cp.razon_social, cp.tipo_contraparte, cp.cuit,
             COALESCE(SUM(cc.debe - cc.haber), 0) as saldo,
             COUNT(CASE WHEN cc.estado = 'ABIERTO' THEN 1 END) as movs_pendientes
      FROM contrapartes cp
      LEFT JOIN cc_contrapartes cc ON cp.id = cc.id_contraparte
      WHERE cp.activo = TRUE
      GROUP BY cp.id, cp.razon_social, cp.tipo_contraparte, cp.cuit
      HAVING COALESCE(SUM(cc.debe - cc.haber), 0) != 0
      ORDER BY ABS(COALESCE(SUM(cc.debe - cc.haber), 0)) DESC
    `);
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
  try {
    const { id_contraparte, id_contrato, id_liquidacion, fecha, tipo_movimiento, concepto, monto, modalidad } = req.body;
    
    if (!id_contraparte || !fecha || !tipo_movimiento || !monto || !modalidad) {
      return res.status(400).json({ error: "Faltan campos obligatorios" });
    }

    const valorMonto = parseFloat(monto);
    if (isNaN(valorMonto) || valorMonto <= 0) {
      return res.status(400).json({ error: "El monto debe ser un número positivo" });
    }

    let debe = 0;
    let haber = 0;
    
    if (tipo_movimiento === 'PAGO' || tipo_movimiento === 'ADELANTO') {
      debe = valorMonto;
    } else if (tipo_movimiento === 'COBRO') {
      haber = valorMonto;
    } else {
      return res.status(400).json({ error: "Tipo de movimiento no válido. Debe ser PAGO, COBRO o ADELANTO" });
    }

    const saldo_acumulado = debe - haber;

    const { rows } = await pool.query(`
      INSERT INTO cc_contrapartes
        (id_contraparte, id_contrato, id_liquidacion, fecha, tipo_movimiento,
         concepto, debe, haber, saldo_acumulado, modalidad, estado)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ABIERTO')
      RETURNING *
    `, [id_contraparte, id_contrato || null, id_liquidacion || null, fecha, tipo_movimiento,
        concepto, debe, haber, saldo_acumulado, modalidad]);

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

module.exports = router;

