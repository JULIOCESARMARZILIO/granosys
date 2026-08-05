const router = require('express').Router();
const { pool } = require('../db');

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM especies ORDER BY nombre');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { nombre, codigo } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO especies (nombre, codigo, activa) VALUES ($1, $2, TRUE) RETURNING *',
      [nombre, codigo.toUpperCase()]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /:id - hoy solo se usa para cargar/actualizar el rendimiento teorico
// de un subproducto (para la calculadora de capacidad de pago)
router.put('/:id', async (req, res) => {
  try {
    const { rendimiento_teorico_pct } = req.body;
    const { rows } = await pool.query(
      'UPDATE especies SET rendimiento_teorico_pct = $1 WHERE id = $2 RETURNING *',
      [rendimiento_teorico_pct === '' || rendimiento_teorico_pct === undefined ? null : rendimiento_teorico_pct, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Especie no encontrada' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/parametros', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM parametros_calidad_especie WHERE id_especie = $1 AND activo = TRUE ORDER BY orden',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
