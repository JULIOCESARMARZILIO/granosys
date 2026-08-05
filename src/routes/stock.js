const router = require('express').Router();
const { pool } = require('../db');
const { camionesDisponiblesEnZona } = require('../services/stockService');

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

// GET /api/stock/por-zona
// Agrupa el stock de todas las ubicaciones de una misma zona/sub-zona de
// referencia (ej. "Rosario Norte") en una sola bolsa: es lo que se puede
// aplicar a un contrato sin importar de que planta puntual vino cada camion.
router.get('/por-zona', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.zona, s.id_especie, e.nombre as especie_nombre, s.id_campana, ca.descripcion as campana_desc,
             SUM(s.toneladas_totales) as toneladas_totales,
             SUM(s.valor_total) as valor_total,
             CASE WHEN SUM(s.toneladas_totales) > 0 THEN SUM(s.valor_total) / SUM(s.toneladas_totales) ELSE 0 END as costo_promedio_ponderado
      FROM stock s
      JOIN ubicaciones u ON s.id_ubicacion = u.id
      LEFT JOIN especies e ON s.id_especie = e.id
      LEFT JOIN campanas ca ON s.id_campana = ca.id
      WHERE u.zona IS NOT NULL AND s.toneladas_totales > 0
      GROUP BY u.zona, s.id_especie, e.nombre, s.id_campana, ca.descripcion
      ORDER BY u.zona, e.nombre
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stock/por-zona/:zona/camiones?id_especie=&id_campana=
// Lista los movimientos (camiones) ya descargados que componen la bolsa de
// esa zona para ese producto/campaña, con cuanto de cada uno todavia esta
// sin aplicar a ningun contrato. Sirve para mostrar, antes de confirmar una
// aplicacion, exactamente que camiones se van a consumir.
router.get('/por-zona/:zona/camiones', async (req, res) => {
  try {
    const { id_especie, id_campana } = req.query;
    if (!id_especie || !id_campana) {
      return res.status(400).json({ error: 'id_especie e id_campana son obligatorios' });
    }
    const camiones = await camionesDisponiblesEnZona({
      zona: req.params.zona,
      id_especie: parseInt(id_especie),
      id_campana: parseInt(id_campana)
    });
    res.json(camiones);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
