const router = require('express').Router();
const { pool } = require('../db');

// POST /api/reportes-descarga - la app móvil manda foto + datos mínimos.
// Queda pendiente hasta que alguien en la oficina lo procese.
router.post('/', async (req, res) => {
  try {
    const {
      foto_base64, mime_type, contraparte_texto, id_comprador,
      lugar_descarga_sugerido, patente_chasis, peso_bruto_kg, peso_tara_kg, observaciones
    } = req.body;
    if (!foto_base64) return res.status(400).json({ error: 'Falta la foto del ticket.' });

    const { rows } = await pool.query(`
      INSERT INTO reportes_descarga
        (foto_base64, mime_type, contraparte_texto, id_comprador, lugar_descarga_sugerido,
         patente_chasis, peso_bruto_kg, peso_tara_kg, observaciones, usuario)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id, contraparte_texto, id_comprador, lugar_descarga_sugerido,
                patente_chasis, peso_bruto_kg, peso_tara_kg, observaciones, usuario, created_at
    `, [
      foto_base64, mime_type || null, contraparte_texto || null, id_comprador || null,
      lugar_descarga_sugerido || null, patente_chasis || null,
      peso_bruto_kg || null, peso_tara_kg || null, observaciones || null,
      req.user?.usuario || null
    ]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reportes-descarga - listado sin la foto (liviano, para la cola de revisión)
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.id, r.contraparte_texto, r.id_comprador, c.razon_social AS comprador_nombre, c.cuit AS comprador_cuit,
             r.lugar_descarga_sugerido, r.patente_chasis, r.peso_bruto_kg, r.peso_tara_kg,
             r.observaciones, r.usuario, r.created_at
      FROM reportes_descarga r
      LEFT JOIN contrapartes c ON c.id = r.id_comprador
      ORDER BY r.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reportes-descarga/:id - detalle completo, con la foto
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.*, c.razon_social AS comprador_nombre, c.cuit AS comprador_cuit
      FROM reportes_descarga r
      LEFT JOIN contrapartes c ON c.id = r.id_comprador
      WHERE r.id = $1
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/reportes-descarga/:id - se llama una vez procesado (borra la foto con la fila)
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM reportes_descarga WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reportes-descarga/ref/localidades - nombres de localidad ya conocidos
// por el sistema (ubicaciones + contrapartes), para que la app móvil sugiera
// una coincidencia contra lo que lee el OCR del ticket.
router.get('/ref/localidades', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT localidad FROM (
        SELECT localidad FROM ubicaciones WHERE localidad IS NOT NULL AND localidad <> ''
        UNION
        SELECT localidad FROM contrapartes WHERE localidad IS NOT NULL AND localidad <> ''
      ) t
      ORDER BY localidad
    `);
    res.json(rows.map(r => r.localidad));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
