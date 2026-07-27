const router = require('express').Router();
const { pool } = require('../db');

// GET listado de auditoria, con filtros opcionales. Solo lectura: no existe
// ninguna ruta de escritura/edicion/borrado aca a proposito.
router.get('/', async (req, res) => {
  try {
    const { modulo, usuario, accion, desde, hasta } = req.query;
    const where = [];
    const params = [];

    if (modulo) { params.push(modulo); where.push(`modulo = $${params.length}`); }
    if (usuario) { params.push(`%${usuario}%`); where.push(`usuario ILIKE $${params.length}`); }
    if (accion) { params.push(accion); where.push(`accion = $${params.length}`); }
    if (desde) { params.push(desde); where.push(`fecha >= $${params.length}`); }
    if (hasta) { params.push(hasta); where.push(`fecha <= $${params.length}`); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT * FROM auditoria ${whereSql} ORDER BY fecha DESC, id DESC LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
