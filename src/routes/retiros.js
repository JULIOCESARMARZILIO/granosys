const router = require('express').Router();
const { pool } = require('../db');
const { restarStockPorZona, stockDisponibleEnZona } = require('../services/stockService');
const { registrarAuditoria } = require('../services/auditoria');

// POST /api/retiros-productor
// Un productor retira (o se le transfiere) formalmente una parte de la
// bolsa de una zona -- el equivalente al C1116A ya certificado. No toca
// ningun contrato. numero_1116rt se completa cuando se tramita en ARCA
// por fuera del sistema (la emision automatica es una etapa aparte).
router.post('/', async (req, res) => {
  try {
    const { id_contraparte, zona, id_especie, id_campana, toneladas, numero_1116rt, observaciones } = req.body;
    if (!id_contraparte || !zona || !id_especie || !id_campana || !toneladas || parseFloat(toneladas) <= 0) {
      return res.status(400).json({ error: 'id_contraparte, zona, id_especie, id_campana y toneladas (mayor a 0) son obligatorios' });
    }

    const disponible = await stockDisponibleEnZona({ zona, id_especie, id_campana });
    if (parseFloat(toneladas) > disponible + 0.001) {
      return res.status(400).json({ error: `La zona "${zona}" solo tiene ${disponible.toFixed(3)}tn disponibles de este producto/campaña.` });
    }

    const usuario = req.get('X-Usuario-Actual') || 'desconocido';
    const kg = parseFloat(toneladas) * 1000;

    const { detalle } = await restarStockPorZona({ zona, id_especie, id_campana, kg });

    const { rows } = await pool.query(
      `INSERT INTO retiros_productor (id_contraparte, zona, id_especie, id_campana, toneladas, numero_1116rt, observaciones, usuario)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id_contraparte, zona, id_especie, id_campana, toneladas, numero_1116rt || null, observaciones || null, usuario]
    );

    await registrarAuditoria(req, {
      accion: 'RETIRO_PRODUCTOR', modulo: 'retiros_productor', registro_id: rows[0].id,
      datos_despues: { ...rows[0], detalle_ubicaciones: detalle }
    });

    res.status(201).json({ retiro: rows[0], detalle_ubicaciones: detalle });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/retiros-productor - historial, opcionalmente filtrado por productor
router.get('/', async (req, res) => {
  try {
    const { id_contraparte } = req.query;
    const params = [];
    let where = '';
    if (id_contraparte) { params.push(id_contraparte); where = 'WHERE r.id_contraparte = $1'; }

    const { rows } = await pool.query(`
      SELECT r.*, cp.razon_social as productor, e.nombre as especie_nombre, ca.descripcion as campana_desc
      FROM retiros_productor r
      LEFT JOIN contrapartes cp ON r.id_contraparte = cp.id
      LEFT JOIN especies e ON r.id_especie = e.id
      LEFT JOIN campanas ca ON r.id_campana = ca.id
      ${where}
      ORDER BY r.id DESC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/retiros-productor/:id - completar el numero de 1116RT una vez tramitado en ARCA
router.put('/:id', async (req, res) => {
  try {
    const { numero_1116rt } = req.body;
    const { rows } = await pool.query(
      'UPDATE retiros_productor SET numero_1116rt = $1 WHERE id = $2 RETURNING *',
      [numero_1116rt || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Retiro no encontrado' });
    await registrarAuditoria(req, {
      accion: 'MODIFICAR', modulo: 'retiros_productor', registro_id: rows[0].id, datos_despues: rows[0]
    });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
