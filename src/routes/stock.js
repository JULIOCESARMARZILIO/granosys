const router = require('express').Router();
const { pool } = require('../db');

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, e.nombre as especie_nombre, ca.descripcion as campana_desc,
             u.nombre as ubicacion_nombre, u.tipo as ubicacion_tipo
      FROM stock s
      LEFT JOIN especies e ON s.id_especie = e.id
      LEFT JOIN campanas ca ON s.id_campana = ca.id
      LEFT JOIN ubicaciones u ON s.id_ubicacion = u.id
      WHERE s.toneladas_totales > 0
      ORDER BY e.nombre, ca.anio_inicio DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
