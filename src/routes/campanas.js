const router = require('express').Router();
const { pool } = require('../db');

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM campanas ORDER BY anio_inicio DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { descripcion, anio_inicio, anio_fin } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO campanas (descripcion, anio_inicio, anio_fin, activa) VALUES ($1, $2, $3, TRUE) RETURNING *',
      [descripcion, parseInt(anio_inicio), parseInt(anio_fin)]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
