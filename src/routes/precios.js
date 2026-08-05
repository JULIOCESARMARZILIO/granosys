const router = require('express').Router();
const { pool } = require('../db');
const { registrarAuditoria } = require('../services/auditoria');
const { precioVigente } = require('../services/preciosService');

// GET /api/precios/vigentes?fecha=YYYY-MM-DD
// Precio general vigente (sin ubicacion/modalidad especifica) de cada
// especie/subproducto activo, a la fecha indicada (hoy por defecto).
// Es lo que se muestra antes de tirar un reporte valorizado, para
// confirmar o actualizar precios.
router.get('/vigentes', async (req, res) => {
  try {
    const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);
    const { rows: especies } = await pool.query(
      `SELECT id, nombre, codigo, tipo_producto, id_especie_origen FROM especies WHERE activa = true ORDER BY tipo_producto, nombre`
    );
    const resultado = [];
    for (const e of especies) {
      const p = await precioVigente(e.id, fecha);
      resultado.push({
        id_especie: e.id,
        especie_nombre: e.nombre,
        codigo: e.codigo,
        tipo_producto: e.tipo_producto,
        precio: p ? parseFloat(p.precio) : null,
        moneda: p ? p.moneda : null,
        vigente_desde: p ? p.vigente_desde : null,
        usuario: p ? p.usuario : null
      });
    }
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/precios/historial/:idEspecie - historial completo de precios de un producto
router.get('/historial/:idEspecie', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, u.nombre as ubicacion_nombre
       FROM precios_referencia p
       LEFT JOIN ubicaciones u ON p.id_ubicacion = u.id
       WHERE p.id_especie = $1
       ORDER BY p.vigente_desde DESC, p.id DESC`,
      [req.params.idEspecie]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/precios - carga un precio nuevo (nunca pisa el anterior, agrega una fila)
router.post('/', async (req, res) => {
  try {
    const { id_especie, precio, moneda, vigente_desde, id_ubicacion, modalidad } = req.body;
    if (!id_especie || precio === undefined || precio === null) {
      return res.status(400).json({ error: 'id_especie y precio son obligatorios' });
    }
    const usuario = req.get('X-Usuario-Actual') || 'desconocido';

    const { rows } = await pool.query(
      `INSERT INTO precios_referencia (id_especie, id_ubicacion, modalidad, precio, moneda, vigente_desde, usuario)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id_especie, id_ubicacion || null, modalidad || null, precio, moneda || 'ARS',
       vigente_desde || new Date().toISOString().slice(0, 10), usuario]
    );

    await registrarAuditoria(req, {
      accion: 'ACTUALIZAR_PRECIO', modulo: 'precios_referencia', registro_id: id_especie,
      datos_despues: rows[0]
    });

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
