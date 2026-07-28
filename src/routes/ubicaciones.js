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

    // Si no se especifica zona a mano, se busca automaticamente: primero por
    // nombre de planta/empresa (mas especifico) y si no, por localidad -- asi
    // cualquier destino nuevo que coincida con algo conocido queda
    // clasificado solo, sin cargar nada extra.
    let zona = null, sub_zona = null;
    const { rows: zn } = await pool.query('SELECT zona, sub_zona FROM zonas_nombre WHERE nombre ILIKE $1', [nombre]);
    if (zn[0]) { zona = zn[0].zona; sub_zona = zn[0].sub_zona; }
    if (!zona && localidad) {
      const { rows: zl } = await pool.query('SELECT zona, sub_zona FROM zonas_localidad WHERE localidad ILIKE $1', [localidad]);
      if (zl[0]) { zona = zl[0].zona; sub_zona = zl[0].sub_zona; }
    }

    const { rows } = await pool.query(
      `INSERT INTO ubicaciones (nombre, tipo, localidad, provincia, direccion, cuit_titular, nro_planta, zona, sub_zona)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [nombre, tipo || 'DESTINO_ENTREGA', localidad || null, provincia || null, direccion || null, cuit_titular || null, nro_planta || null, zona, sub_zona]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/ubicaciones/:id - carga manual de zona/sub-zona (bolsa de stock)
// y la distancia a la referencia (flete)
router.put('/:id', async (req, res) => {
  try {
    const { zona, sub_zona, km_a_referencia } = req.body;
    const { rows } = await pool.query(
      `UPDATE ubicaciones SET
         zona = COALESCE($1, zona),
         sub_zona = COALESCE($2, sub_zona),
         km_a_referencia = CASE WHEN $3::text IS NOT NULL THEN $3::decimal ELSE km_a_referencia END
       WHERE id = $4 RETURNING *`,
      [zona || null, sub_zona || null, km_a_referencia !== undefined && km_a_referencia !== '' ? km_a_referencia : null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Ubicación no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ubicaciones/referencias/zonas - tabla de referencia localidad->zona
router.get('/referencias/zonas', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM zonas_localidad ORDER BY zona, sub_zona, localidad');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ubicaciones/referencias/zonas - agrega o actualiza una localidad
// en la tabla de referencia, y re-aplica la clasificacion a las ubicaciones
// que ya tenian esa localidad cargada sin zona.
router.post('/referencias/zonas', async (req, res) => {
  try {
    const { localidad, zona, sub_zona } = req.body;
    if (!localidad || !zona) return res.status(400).json({ error: 'localidad y zona son obligatorios' });
    const { rows } = await pool.query(
      `INSERT INTO zonas_localidad (localidad, zona, sub_zona) VALUES ($1,$2,$3)
       ON CONFLICT (localidad) DO UPDATE SET zona = $2, sub_zona = $3 RETURNING *`,
      [localidad, zona, sub_zona || null]
    );
    await pool.query(
      `UPDATE ubicaciones SET zona = $1, sub_zona = $2 WHERE localidad ILIKE $3`,
      [zona, sub_zona || null, localidad]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ubicaciones/referencias/zonas-nombre - tabla de referencia nombre->zona
router.get('/referencias/zonas-nombre', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM zonas_nombre ORDER BY zona, sub_zona, nombre');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ubicaciones/referencias/zonas-nombre - agrega/actualiza una
// planta/empresa por nombre en la tabla de referencia, y re-aplica la
// clasificacion a las ubicaciones que ya tenian ese nombre cargado.
router.post('/referencias/zonas-nombre', async (req, res) => {
  try {
    const { nombre, zona, sub_zona } = req.body;
    if (!nombre || !zona) return res.status(400).json({ error: 'nombre y zona son obligatorios' });
    const { rows } = await pool.query(
      `INSERT INTO zonas_nombre (nombre, zona, sub_zona) VALUES ($1,$2,$3)
       ON CONFLICT (nombre) DO UPDATE SET zona = $2, sub_zona = $3 RETURNING *`,
      [nombre, zona, sub_zona || null]
    );
    await pool.query(
      `UPDATE ubicaciones SET zona = $1, sub_zona = $2 WHERE nombre ILIKE $3`,
      [zona, sub_zona || null, nombre]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/ubicaciones/:id - baja lógica (deja de aparecer en listados/selectores)
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('UPDATE ubicaciones SET activo = false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
