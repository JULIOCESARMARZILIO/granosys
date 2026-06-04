const router = require('express').Router();
const { pool } = require('../db');

// GET todos los contratos
router.get('/', async (req, res) => {
  try {
    const { modalidad, tipo, estado } = req.query;
    let query = `
      SELECT c.*, cp.razon_social as contraparte_nombre, 
             e.nombre as especie_nombre, ca.descripcion as campana_desc
      FROM contratos c
      LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
      LEFT JOIN especies e ON c.id_especie = e.id
      LEFT JOIN campanas ca ON c.id_campana = ca.id
      WHERE c.activo = TRUE
    `;
    const params = [];
    if (modalidad) { params.push(modalidad); query += ` AND c.modalidad = $${params.length}`; }
    if (tipo) { params.push(tipo); query += ` AND c.tipo_contrato = $${params.length}`; }
    if (estado) { params.push(estado); query += ` AND c.estado = $${params.length}`; }
    query += ' ORDER BY c.created_at DESC';

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET un contrato con sus movimientos
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, cp.razon_social as contraparte_nombre,
             e.nombre as especie_nombre, ca.descripcion as campana_desc
      FROM contratos c
      LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
      LEFT JOIN especies e ON c.id_especie = e.id
      LEFT JOIN campanas ca ON c.id_campana = ca.id
      WHERE c.id = $1
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });

    // Movimientos del contrato
    const { rows: movs } = await pool.query(`
      SELECT m.*, e.nombre as especie_nombre
      FROM movimientos m
      LEFT JOIN especies e ON m.id_especie = e.id
      WHERE m.id_contrato_compra = $1 OR m.id_contrato_venta = $1
      ORDER BY m.created_at DESC
    `, [req.params.id]);

    res.json({ ...rows[0], movimientos: movs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST crear contrato
router.post('/', async (req, res) => {
  try {
    const {
      tipo_contrato, modalidad, tipo_liquidacion, fecha_contrato,
      fecha_entrega_desde, fecha_entrega_hasta, id_contraparte,
      id_especie, id_campana, cantidad_toneladas_pactadas,
      tipo_precio, moneda, precio_pactado, referencia_fijacion,
      diferencial_fijacion, tipo_diferencial, tipo_entrega,
      localidad_entrega, provincia_entrega, flete_estimado,
      forma_pago, plazo_pago_dias, condicion_pago,
      precio_venta_estimado, destino_venta_estimado, observaciones
    } = req.body;

    // Generar número de contrato
    const prefix = tipo_contrato === 'COMPRA' ? 'OC' : tipo_contrato === 'VENTA' ? 'OV' : 'CA';
    const year = new Date().getFullYear();
    const { rows: last } = await pool.query(
      "SELECT numero_contrato FROM contratos WHERE numero_contrato LIKE $1 ORDER BY id DESC LIMIT 1",
      [`${prefix}-${year}-%`]
    );
    const num = last[0] ? parseInt(last[0].numero_contrato.split('-')[2]) + 1 : 1;
    const numero_contrato = `${prefix}-${year}-${String(num).padStart(4, '0')}`;

    const { rows } = await pool.query(`
      INSERT INTO contratos (
        numero_contrato, tipo_contrato, modalidad, tipo_liquidacion,
        fecha_contrato, fecha_entrega_desde, fecha_entrega_hasta,
        id_contraparte, id_especie, id_campana, cantidad_toneladas_pactadas,
        tipo_precio, moneda, precio_pactado, referencia_fijacion,
        diferencial_fijacion, tipo_diferencial, tipo_entrega,
        localidad_entrega, provincia_entrega, flete_estimado,
        forma_pago, plazo_pago_dias, condicion_pago,
        precio_venta_estimado, destino_venta_estimado,
        localidad_entrega_pactada, comprador_estimado_id,
        aplica_cpe, costo_cpe_pct, costo_financiero_pct,
        observaciones, estado
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
        $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
        $28,$29,$30,$31,$32,'CONFIRMADO'
      ) RETURNING *
    `, [numero_contrato, tipo_contrato, modalidad, tipo_liquidacion,
        fecha_contrato, fecha_entrega_desde||null, fecha_entrega_hasta||null,
        id_contraparte, id_especie, id_campana, cantidad_toneladas_pactadas,
        tipo_precio, moneda, precio_pactado||null, referencia_fijacion||null,
        diferencial_fijacion||null, tipo_diferencial||null, tipo_entrega,
        localidad_entrega, provincia_entrega, flete_estimado||null,
        forma_pago, plazo_pago_dias||0, condicion_pago||'CONTADO',
        precio_venta_estimado||null, destino_venta_estimado,
        req.body.localidad_entrega_pactada||null,
        req.body.comprador_estimado_id||null,
        req.body.aplica_cpe||false,
        req.body.costo_cpe_pct||null,
        req.body.costo_financiero_pct||null,
        observaciones]);

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT actualizar estado
router.put('/:id/estado', async (req, res) => {
  try {
    const { estado } = req.body;
    const { rows } = await pool.query(
      'UPDATE contratos SET estado=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
      [estado, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
