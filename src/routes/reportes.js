const router = require('express').Router();
const { pool } = require('../db');

// Reporte de pendientes — el corazón del módulo
router.get('/pendientes', async (req, res) => {
  try {
    // 1. Movimientos en tránsito sin llegada
    const { rows: enTransito } = await pool.query(`
      SELECT m.numero_movimiento, m.modalidad, m.fecha_partida,
             m.localidad_origen, m.provincia_origen,
             m.localidad_destino, m.provincia_destino,
             m.peso_neto_salida_kg, e.nombre as especie,
             c.numero_contrato,
             EXTRACT(DAY FROM NOW() - m.created_at) as dias_desde_salida
      FROM movimientos m
      LEFT JOIN especies e ON m.id_especie = e.id
      LEFT JOIN contratos c ON m.id_contrato_compra = c.id
      WHERE m.estado = 'EN_TRANSITO'
      ORDER BY m.created_at ASC
    `);

    // 2. Movimientos descargados sin liquidar
    const { rows: sinLiquidar } = await pool.query(`
      SELECT m.numero_movimiento, m.modalidad, m.fecha_descarga,
             m.kg_liquidables, m.factor_aplicado,
             e.nombre as especie, c.numero_contrato,
             cp.razon_social as productor,
             EXTRACT(DAY FROM NOW() - m.fecha_descarga) as dias_desde_descarga
      FROM movimientos m
      LEFT JOIN especies e ON m.id_especie = e.id
      LEFT JOIN contratos c ON m.id_contrato_compra = c.id
      LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
      WHERE m.estado = 'DESCARGADO' AND m.estado_liquidacion != 'LIQUIDADO'
      ORDER BY m.fecha_descarga ASC
    `);

    // 3. Movimientos sin contrato asignado
    const { rows: sinContrato } = await pool.query(`
      SELECT m.numero_movimiento, m.modalidad, m.created_at,
             e.nombre as especie, m.peso_neto_salida_kg,
             m.localidad_origen
      FROM movimientos m
      LEFT JOIN especies e ON m.id_especie = e.id
      WHERE m.id_contrato_compra IS NULL
      ORDER BY m.created_at ASC
    `);

    // 4. Movimientos sin calidad registrada
    const { rows: sinCalidad } = await pool.query(`
      SELECT m.numero_movimiento, m.modalidad, e.nombre as especie,
             m.kg_liquidables, m.factor_aplicado
      FROM movimientos m
      LEFT JOIN especies e ON m.id_especie = e.id
      LEFT JOIN calidad_movimiento cm ON m.id = cm.id_movimiento
      WHERE m.estado = 'DESCARGADO' AND cm.id IS NULL
    `);

    // 5. Contratos con entrega vencida
    const { rows: contratosVencidos } = await pool.query(`
      SELECT c.numero_contrato, c.tipo_contrato, c.modalidad,
             c.fecha_entrega_hasta, c.cantidad_toneladas_pactadas,
             c.cantidad_toneladas_asignadas,
             c.cantidad_toneladas_pactadas - c.cantidad_toneladas_asignadas as tn_pendientes,
             cp.razon_social as contraparte, e.nombre as especie
      FROM contratos c
      LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
      LEFT JOIN especies e ON c.id_especie = e.id
      WHERE c.fecha_entrega_hasta < NOW()
        AND c.estado NOT IN ('CUMPLIDO', 'CANCELADO')
        AND c.activo = TRUE
      ORDER BY c.fecha_entrega_hasta ASC
    `);

    // 6. Contratos a fijar sin precio
    const { rows: aFijar } = await pool.query(`
      SELECT c.numero_contrato, c.tipo_contrato, c.modalidad,
             c.cantidad_toneladas_pactadas, c.referencia_fijacion,
             c.diferencial_fijacion, c.tipo_diferencial,
             cp.razon_social as contraparte, e.nombre as especie,
             ca.descripcion as campana,
             EXTRACT(DAY FROM NOW() - c.created_at) as dias_sin_precio
      FROM contratos c
      LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
      LEFT JOIN especies e ON c.id_especie = e.id
      LEFT JOIN campanas ca ON c.id_campana = ca.id
      WHERE c.tipo_precio = 'A_FIJAR' AND c.precio_fijado IS NULL
        AND c.estado NOT IN ('CANCELADO') AND c.activo = TRUE
      ORDER BY c.created_at ASC
    `);

    // 7. Liquidaciones emitidas sin pagar
    const { rows: sinPagar } = await pool.query(`
      SELECT l.nro_liquidacion, l.tipo, l.modalidad, l.fecha_liquidacion,
             l.monto_neto_a_pagar, l.moneda,
             cp.razon_social as contraparte,
             EXTRACT(DAY FROM NOW() - l.fecha_liquidacion) as dias_emitida
      FROM liquidaciones l
      LEFT JOIN contrapartes cp ON l.id_contraparte = cp.id
      WHERE l.estado = 'EMITIDA'
      ORDER BY l.fecha_liquidacion ASC
    `);

    res.json({
      en_transito: enTransito,
      sin_liquidar: sinLiquidar,
      sin_contrato: sinContrato,
      sin_calidad: sinCalidad,
      contratos_vencidos: contratosVencidos,
      a_fijar: aFijar,
      sin_pagar: sinPagar,
      resumen: {
        total_en_transito: enTransito.length,
        total_sin_liquidar: sinLiquidar.length,
        total_sin_contrato: sinContrato.length,
        total_sin_calidad: sinCalidad.length,
        total_contratos_vencidos: contratosVencidos.length,
        total_a_fijar: aFijar.length,
        total_sin_pagar: sinPagar.length,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reporte de márgenes por contrato
router.get('/margenes', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        c.numero_contrato, c.tipo_contrato, c.modalidad,
        e.nombre as especie, ca.descripcion as campana,
        cp.razon_social as contraparte,
        c.cantidad_toneladas_pactadas,
        c.precio_pactado, c.precio_venta_estimado,
        c.flete_estimado,
        (c.precio_venta_estimado - c.precio_pactado - COALESCE(c.flete_estimado,0)) as margen_estimado_tn,
        c.cantidad_toneladas_pactadas * (c.precio_venta_estimado - c.precio_pactado - COALESCE(c.flete_estimado,0)) as margen_estimado_total
      FROM contratos c
      LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
      LEFT JOIN especies e ON c.id_especie = e.id
      LEFT JOIN campanas ca ON c.id_campana = ca.id
      WHERE c.tipo_contrato = 'COMPRA'
        AND c.precio_venta_estimado IS NOT NULL
        AND c.activo = TRUE
      ORDER BY margen_estimado_total DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reporte de posición a fijar
router.get('/posicion-fijar', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.numero_contrato, c.tipo_contrato, c.modalidad,
             e.nombre as especie, ca.descripcion as campana,
             cp.razon_social as contraparte,
             c.cantidad_toneladas_pactadas as tn_totales,
             c.cantidad_toneladas_asignadas as tn_asignadas,
             c.referencia_fijacion, c.diferencial_fijacion, c.tipo_diferencial,
             EXTRACT(DAY FROM NOW() - c.created_at) as dias_abierto
      FROM contratos c
      LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
      LEFT JOIN especies e ON c.id_especie = e.id
      LEFT JOIN campanas ca ON c.id_campana = ca.id
      WHERE c.tipo_precio = 'A_FIJAR'
        AND c.precio_fijado IS NULL
        AND c.estado NOT IN ('CANCELADO')
        AND c.activo = TRUE
      ORDER BY dias_abierto DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
