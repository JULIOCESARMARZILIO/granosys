const router = require('express').Router();
const { pool } = require('../db');

// GET todas las contrapartes
router.get('/', async (req, res) => {
  try {
    const { modalidad, tipo, search } = req.query;
    let query = 'SELECT * FROM contrapartes WHERE 1=1';
    const params = [];

    if (modalidad === 'FORMAL') {
      query += ' AND cuit IS NOT NULL';
    }
    if (tipo) {
      params.push(tipo);
      query += ` AND (tipo_contraparte = $${params.length} OR tipo_contraparte = 'AMBOS')`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (razon_social ILIKE $${params.length} OR cuit ILIKE $${params.length})`;
    }
    query += ' ORDER BY razon_social';

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET una contraparte
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM contrapartes WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrada' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST crear contraparte
router.post('/', async (req, res) => {
  try {
    const { cuit, razon_social, tipo_contraparte, canal_operacion, condicion_iva,
            domicilio, localidad, provincia, telefono, email, observaciones } = req.body;

    // Generar código interno
    const { rows: last } = await pool.query(
      "SELECT codigo_interno FROM contrapartes WHERE codigo_interno LIKE $1 ORDER BY id DESC LIMIT 1",
      [tipo_contraparte === 'COMPRADOR' ? 'C-%' : 'P-%']
    );
    const prefix = tipo_contraparte === 'COMPRADOR' ? 'C' : 'P';
    const num = last[0] ? parseInt(last[0].codigo_interno.split('-')[1]) + 1 : 1;
    const codigo_interno = `${prefix}-${String(num).padStart(4, '0')}`;

    const { rows } = await pool.query(`
      INSERT INTO contrapartes (codigo_interno, cuit, razon_social, tipo_contraparte,
        canal_operacion, condicion_iva, domicilio, localidad, provincia, telefono, email, observaciones)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [codigo_interno, cuit||null, razon_social, tipo_contraparte,
        canal_operacion||'AMBOS', condicion_iva, domicilio, localidad,
        provincia, telefono, email, observaciones]);

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT actualizar contraparte
router.put('/:id', async (req, res) => {
  try {
    const { cuit, razon_social, tipo_contraparte, condicion_iva,
            domicilio, localidad, provincia, telefono, email, activo } = req.body;
    const { rows } = await pool.query(`
      UPDATE contrapartes SET
        cuit=$1, razon_social=$2, tipo_contraparte=$3, condicion_iva=$4,
        domicilio=$5, localidad=$6, provincia=$7, telefono=$8, email=$9,
        activo=$10, updated_at=NOW()
      WHERE id=$11 RETURNING *
    `, [cuit, razon_social, tipo_contraparte, condicion_iva,
        domicilio, localidad, provincia, telefono, email, activo, req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
