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

module.exports = router;
