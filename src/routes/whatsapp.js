const router = require('express').Router();
const { extraerComprobante, guardarEnStaging, ExtraccionError } = require('../services/geminiExtraction');

// POST /api/whatsapp/comprobante
// Body: { texto, imagen_base64, mime_type, telefono_remitente, media_url }
// imagen_base64: string base64 SIN el prefijo "data:image/...;base64,".
router.post('/comprobante', async (req, res) => {
  try {
    const { texto, imagen_base64, mime_type, telefono_remitente, media_url } = req.body;

    const datosExtraidos = await extraerComprobante({
      texto,
      imagenBase64: imagen_base64,
      mimeType: mime_type
    });

    const registro = await guardarEnStaging(datosExtraidos, {
      telefonoRemitente: telefono_remitente,
      mensajeTexto: texto,
      mediaUrl: media_url
    });

    res.status(201).json({ success: true, staging: registro });
  } catch (err) {
    if (err instanceof ExtraccionError) {
      return res.status(422).json({ success: false, error: err.message });
    }
    console.error('Error procesando comprobante WhatsApp:', err);
    res.status(500).json({ success: false, error: 'Error interno al procesar el comprobante.' });
  }
});

// GET /api/whatsapp/pendientes - bandeja para validación humana
router.get('/pendientes', async (req, res) => {
  try {
    const { pool } = require('../db');
    const { rows } = await pool.query(
      "SELECT * FROM staging_movimientos WHERE estado = 'Pendiente_Autorizacion' ORDER BY id DESC"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/whatsapp/comprobante/:id - descartar una captura en staging (ej: prueba o extracción errónea)
router.delete('/comprobante/:id', async (req, res) => {
  try {
    const { pool } = require('../db');
    const { rows } = await pool.query(
      'DELETE FROM staging_movimientos WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Registro no encontrado en staging.' });
    }
    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
