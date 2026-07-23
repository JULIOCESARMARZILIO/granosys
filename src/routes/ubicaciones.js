const router = require('express').Router();
const { pool } = require('../db');

// GET /api/ubicaciones - listado general (para buscar y asociar una ya existente a un comprador)
router.get('/', async (req, res) => {
  try {
    const { q } = req.query;
    const params = [];
    let where = 'WHERE activo = true';
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (nombre ILIKE $${params.length} OR localidad ILIKE $${params.length} OR provincia ILIKE $${params.length})`;
    }
    const { rows } = await pool.query(`SELECT * FROM ubicaciones ${where} ORDER BY nombre ASC`, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ubicaciones - crear una ubicación/planta de destino nueva (sin asociarla todavía a ninguna contraparte)
router.post('/', async (req, res) => {
  try {
    const { nombre, tipo, localidad, provincia, direccion, cuit_titular, nro_planta } = req.body;
    if (!nombre) {
      return res.status(400).json({ error: 'El nombre de la ubicación es obligatorio.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO ubicaciones (nombre, tipo, localidad, provincia, direccion, cuit_titular, nro_planta)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [nombre, tipo || 'DESTINO_ENTREGA', localidad || null, provincia || null, direccion || null, cuit_titular || null, nro_planta || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
