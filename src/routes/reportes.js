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

// GET /financiero - Cuánto hay que pagar/cobrar, agrupado por período y por
// acreedor. Separa GRANOS (liquidaciones a contrapartes vía cc_contrapartes)
// de FLETES (pagos a transportistas vía cc_transportistas), porque son dos
// circuitos y dos tablas totalmente distintos en el esquema.
//
// Dos vistas distintas a propósito:
//   - por_periodo: movimientos de cta-cte FECHADOS dentro de [desde, hasta],
//     agrupados por día/semana/mes. Sirve para proyectar cuánta plata nueva
//     se compromete por período (planificación de caja hacia adelante).
//   - por_acreedor: saldo NETO ACUMULADO histórico (todo el tiempo, sin
//     filtro de fecha) de cada contraparte/transportista al que se le debe
//     plata ahora mismo. Ninguna de las dos tablas tiene fecha de
//     vencimiento ni un flag de "pagado", así que "cuánto le debo a Juan hoy"
//     solo puede calcularse como la suma histórica completa, no acotada al
//     rango del reporte. Ordenado de mayor a menor deuda para poder decidir
//     a quién adelantar o atrasar el pago.
router.get('/financiero', async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const agrupacion = req.query.agrupacion || 'dia';
    const unitMap = { dia: 'day', semana: 'week', mes: 'month' };
    const unit = unitMap[agrupacion];

    if (!unit) {
      return res.status(400).json({ error: "El parámetro agrupacion debe ser 'dia', 'semana' o 'mes'" });
    }
    if (!desde || !hasta) {
      return res.status(400).json({ error: 'Los parámetros desde y hasta (YYYY-MM-DD) son obligatorios' });
    }
    const formato = unit === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';

    // Granos: liquidaciones + pagos/cobros/adelantos a contrapartes, dentro del rango
    const { rows: granosPorPeriodo } = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC($3, cc.fecha), $4) as periodo,
        MIN(cc.fecha) as periodo_desde,
        COALESCE(SUM(cc.haber - cc.debe), 0) as granos_neto,
        COUNT(*) as cantidad_movimientos
      FROM cc_contrapartes cc
      WHERE cc.fecha BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY MIN(cc.fecha) ASC
    `, [desde, hasta, unit, formato]);

    // Fletes: pagos/facturas/ajustes a transportistas, dentro del rango
    const { rows: fletesPorPeriodo } = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC($3, cct.fecha), $4) as periodo,
        MIN(cct.fecha) as periodo_desde,
        COALESCE(SUM(cct.haber - cct.debe), 0) as fletes_neto,
        COUNT(*) as cantidad_movimientos
      FROM cc_transportistas cct
      WHERE cct.fecha BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY MIN(cct.fecha) ASC
    `, [desde, hasta, unit, formato]);

    // Merge de ambas series por período
    const periodos = new Map();
    for (const r of granosPorPeriodo) {
      periodos.set(r.periodo, {
        periodo: r.periodo,
        periodo_desde: r.periodo_desde,
        granos_neto: parseFloat(r.granos_neto),
        fletes_neto: 0,
        cantidad_movimientos: parseInt(r.cantidad_movimientos, 10),
      });
    }
    for (const r of fletesPorPeriodo) {
      const existente = periodos.get(r.periodo);
      if (existente) {
        existente.fletes_neto = parseFloat(r.fletes_neto);
        existente.cantidad_movimientos += parseInt(r.cantidad_movimientos, 10);
      } else {
        periodos.set(r.periodo, {
          periodo: r.periodo,
          periodo_desde: r.periodo_desde,
          granos_neto: 0,
          fletes_neto: parseFloat(r.fletes_neto),
          cantidad_movimientos: parseInt(r.cantidad_movimientos, 10),
        });
      }
    }
    const por_periodo = Array.from(periodos.values())
      .map(p => ({ ...p, total_neto: Math.round((p.granos_neto + p.fletes_neto) * 100) / 100 }))
      .sort((a, b) => new Date(a.periodo_desde) - new Date(b.periodo_desde));

    // Ranking de acreedores (saldo positivo = todavía se les debe), sin filtro de fecha
    const { rows: acreedoresGranos } = await pool.query(`
      SELECT cp.id as id_entidad, cp.razon_social as nombre, cp.tipo_contraparte,
             COALESCE(SUM(cc.haber - cc.debe), 0) as monto_adeudado,
             COUNT(*) as movimientos, MIN(cc.fecha) as fecha_mas_antigua
      FROM cc_contrapartes cc
      JOIN contrapartes cp ON cc.id_contraparte = cp.id
      GROUP BY cp.id, cp.razon_social, cp.tipo_contraparte
      HAVING COALESCE(SUM(cc.haber - cc.debe), 0) > 0
      ORDER BY monto_adeudado DESC
    `);

    const { rows: acreedoresFletes } = await pool.query(`
      SELECT t.id as id_entidad, t.razon_social as nombre,
             COALESCE(SUM(cct.haber - cct.debe), 0) as monto_adeudado,
             COUNT(*) as movimientos, MIN(cct.fecha) as fecha_mas_antigua
      FROM cc_transportistas cct
      JOIN transportistas t ON cct.id_transportista = t.id
      GROUP BY t.id, t.razon_social
      HAVING COALESCE(SUM(cct.haber - cct.debe), 0) > 0
      ORDER BY monto_adeudado DESC
    `);

    const hoy = Date.now();
    const diasPendiente = (fecha) => Math.floor((hoy - new Date(fecha).getTime()) / 86400000);

    const por_acreedor = [
      ...acreedoresGranos.map(r => ({
        categoria: 'GRANOS',
        id_entidad: r.id_entidad,
        nombre: r.nombre,
        tipo_contraparte: r.tipo_contraparte,
        monto_adeudado: Math.round(parseFloat(r.monto_adeudado) * 100) / 100,
        movimientos: parseInt(r.movimientos, 10),
        fecha_mas_antigua: r.fecha_mas_antigua,
        dias_pendiente: diasPendiente(r.fecha_mas_antigua),
      })),
      ...acreedoresFletes.map(r => ({
        categoria: 'FLETES',
        id_entidad: r.id_entidad,
        nombre: r.nombre,
        tipo_contraparte: null,
        monto_adeudado: Math.round(parseFloat(r.monto_adeudado) * 100) / 100,
        movimientos: parseInt(r.movimientos, 10),
        fecha_mas_antigua: r.fecha_mas_antigua,
        dias_pendiente: diasPendiente(r.fecha_mas_antigua),
      })),
    ].sort((a, b) => b.monto_adeudado - a.monto_adeudado);

    res.json({ agrupacion, desde, hasta, por_periodo, por_acreedor });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
