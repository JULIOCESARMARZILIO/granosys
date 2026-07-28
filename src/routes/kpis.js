const router = require('express').Router();
const { pool } = require('../db');

// GET /api/kpis/margen-clientes
// Margen bruto por comprador: lo facturado en liquidaciones de venta menos
// el costo de compra de esos mismos movimientos (cuando el movimiento tiene
// un contrato de compra vinculado, usa su precio; si no, el margen queda
// sin calcular para ese tramo, se muestra aparte para no mentir el numero).
router.get('/margen-clientes', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        cp.id as id_contraparte, cp.razon_social as cliente,
        lm.id_movimiento, lm.kg_liquidables, lm.precio_aplicado as precio_venta,
        cc.tipo_precio as compra_tipo_precio, cc.precio_pactado as compra_precio_pactado, cc.precio_fijado as compra_precio_fijado
      FROM liquidaciones l
      JOIN liquidacion_movimientos lm ON lm.id_liquidacion = l.id
      JOIN contrapartes cp ON l.id_contraparte = cp.id
      JOIN movimientos m ON lm.id_movimiento = m.id
      LEFT JOIN contratos cc ON m.id_contrato_compra = cc.id
      WHERE l.tipo = 'VENTA'
    `);

    const porCliente = new Map();
    for (const r of rows) {
      if (!porCliente.has(r.id_contraparte)) {
        porCliente.set(r.id_contraparte, { cliente: r.cliente, tn_total: 0, ingreso_total: 0, costo_total: 0, tn_sin_costo: 0 });
      }
      const g = porCliente.get(r.id_contraparte);
      const tn = parseFloat(r.kg_liquidables) / 1000;
      const precioVenta = parseFloat(r.precio_venta) || 0;
      g.tn_total += tn;
      g.ingreso_total += tn * precioVenta;

      const precioCompra = r.compra_tipo_precio === 'FIJO' ? parseFloat(r.compra_precio_pactado)
        : r.compra_tipo_precio === 'A_FIJAR' && r.compra_precio_fijado !== null ? parseFloat(r.compra_precio_fijado)
        : null;
      if (precioCompra !== null) {
        g.costo_total += tn * precioCompra;
      } else {
        g.tn_sin_costo += tn;
      }
    }

    const resultado = Array.from(porCliente.values()).map(g => ({
      cliente: g.cliente,
      toneladas: Math.round(g.tn_total * 1000) / 1000,
      ingreso_total: Math.round(g.ingreso_total * 100) / 100,
      costo_total: Math.round(g.costo_total * 100) / 100,
      margen_bruto: Math.round((g.ingreso_total - g.costo_total) * 100) / 100,
      toneladas_sin_costo_de_referencia: Math.round(g.tn_sin_costo * 1000) / 1000
    })).sort((a, b) => b.margen_bruto - a.margen_bruto);

    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/kpis/antiguedad-saldos
// Antiguedad de los saldos abiertos en cuenta corriente, por contraparte,
// agrupados en rangos de dias desde la fecha del movimiento.
router.get('/antiguedad-saldos', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT cc.id_contraparte, cp.razon_social as contraparte, cc.fecha, cc.debe, cc.haber,
        EXTRACT(DAY FROM NOW() - cc.fecha) as dias
      FROM cc_contrapartes cc
      JOIN contrapartes cp ON cc.id_contraparte = cp.id
      WHERE cc.estado = 'ABIERTO'
    `);

    const porContraparte = new Map();
    for (const r of rows) {
      const saldo = parseFloat(r.debe) - parseFloat(r.haber);
      if (Math.abs(saldo) < 0.01) continue;
      if (!porContraparte.has(r.id_contraparte)) {
        porContraparte.set(r.id_contraparte, { contraparte: r.contraparte, d0_30: 0, d31_60: 0, d61_90: 0, d90_mas: 0, total: 0 });
      }
      const g = porContraparte.get(r.id_contraparte);
      const dias = parseFloat(r.dias);
      if (dias <= 30) g.d0_30 += saldo;
      else if (dias <= 60) g.d31_60 += saldo;
      else if (dias <= 90) g.d61_90 += saldo;
      else g.d90_mas += saldo;
      g.total += saldo;
    }

    const resultado = Array.from(porContraparte.values())
      .map(g => ({
        contraparte: g.contraparte,
        d0_30: Math.round(g.d0_30 * 100) / 100,
        d31_60: Math.round(g.d31_60 * 100) / 100,
        d61_90: Math.round(g.d61_90 * 100) / 100,
        d90_mas: Math.round(g.d90_mas * 100) / 100,
        total: Math.round(g.total * 100) / 100
      }))
      .filter(g => Math.abs(g.total) > 0.01)
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/kpis/rotacion-stock
// Para cada producto/ubicacion con stock, cuanto entro y salio en los
// ultimos 30 dias (proxy de rotacion) comparado con el stock actual.
router.get('/rotacion-stock', async (req, res) => {
  try {
    const { rows: stockActual } = await pool.query(`
      SELECT s.id_ubicacion, s.id_especie, e.nombre as especie_nombre, u.nombre as ubicacion_nombre, s.toneladas_totales
      FROM stock s
      JOIN especies e ON s.id_especie = e.id
      JOIN ubicaciones u ON s.id_ubicacion = u.id
      WHERE s.toneladas_totales > 0
    `);

    const { rows: entradas } = await pool.query(`
      SELECT id_ubicacion_destino as id_ubicacion, id_especie, SUM(kg_liquidables)/1000 as tn
      FROM movimientos
      WHERE id_ubicacion_destino IS NOT NULL AND fecha_descarga >= NOW() - INTERVAL '30 days'
      GROUP BY id_ubicacion_destino, id_especie
    `);
    const { rows: salidas } = await pool.query(`
      SELECT id_ubicacion_origen as id_ubicacion, id_especie, SUM(kg_liquidables)/1000 as tn
      FROM movimientos
      WHERE id_ubicacion_origen IS NOT NULL AND fecha_descarga >= NOW() - INTERVAL '30 days'
      GROUP BY id_ubicacion_origen, id_especie
    `);

    const claveOf = (u, e) => `${u}|${e}`;
    const entradasMap = new Map(entradas.map(r => [claveOf(r.id_ubicacion, r.id_especie), parseFloat(r.tn)]));
    const salidasMap = new Map(salidas.map(r => [claveOf(r.id_ubicacion, r.id_especie), parseFloat(r.tn)]));

    const resultado = stockActual.map(s => {
      const clave = claveOf(s.id_ubicacion, s.id_especie);
      const tnEntraron = entradasMap.get(clave) || 0;
      const tnSalieron = salidasMap.get(clave) || 0;
      return {
        especie_nombre: s.especie_nombre,
        ubicacion_nombre: s.ubicacion_nombre,
        stock_actual: parseFloat(s.toneladas_totales),
        entraron_30d: Math.round(tnEntraron * 1000) / 1000,
        salieron_30d: Math.round(tnSalieron * 1000) / 1000
      };
    }).sort((a, b) => b.stock_actual - a.stock_actual);

    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
