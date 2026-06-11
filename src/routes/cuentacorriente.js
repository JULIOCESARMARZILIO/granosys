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

module.exports = router;
