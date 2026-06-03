const router = require('express').Router();
const { pool } = require('../db');

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM especies WHERE activa = TRUE ORDER BY nombre');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/parametros', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM parametros_calidad_especie WHERE id_especie = $1 AND activo = TRUE ORDER BY orden',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
