const router = require('express').Router();
const { pool } = require('../db');
const { precioNetoUbicacion } = require('../services/preciosService');

// GET /api/posicion/consolidada
// Todo lo que todavia no esta liquidado (sin importar en que planta este,
// propia o de un tercero), valuado: al precio de venta si ya esta vendido
// y fijado; al precio de referencia neto de flete si esta a fijar (de
// venta o de compra); nunca al costo de compra si ya hay venta (ahi manda
// el precio de venta, aunque no este fijado, se usa referencia).
router.get('/consolidada', async (req, res) => {
  try {
    const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);

    const { rows: movs } = await pool.query(`
      SELECT
        m.id, m.kg_liquidables, m.id_especie,
        e.nombre as especie_nombre,
        m.id_ubicacion_destino,
        ud.nombre as ubicacion_destino_nombre,
        m.destino_nombre,
        cc.tipo_precio as compra_tipo_precio, cc.precio_pactado as compra_precio_pactado, cc.precio_fijado as compra_precio_fijado,
        cv.tipo_precio as venta_tipo_precio, cv.precio_pactado as venta_precio_pactado, cv.precio_fijado as venta_precio_fijado
      FROM movimientos m
      JOIN especies e ON m.id_especie = e.id
      LEFT JOIN ubicaciones ud ON m.id_ubicacion_destino = ud.id
      LEFT JOIN contratos cc ON m.id_contrato_compra = cc.id
      LEFT JOIN contratos cv ON m.id_contrato_venta = cv.id
      WHERE m.estado_liquidacion != 'LIQUIDADO'
        AND m.kg_liquidables IS NOT NULL
    `);

    // Agrupar por especie + ubicacion (propia por id, o "tercero" por nombre de destino)
    const grupos = new Map();
    for (const m of movs) {
      const claveUbic = m.id_ubicacion_destino ? `propia:${m.id_ubicacion_destino}` : `tercero:${m.destino_nombre || 'sin especificar'}`;
      const clave = `${m.id_especie}|${claveUbic}`;
      if (!grupos.has(clave)) {
        grupos.set(clave, {
          id_especie: m.id_especie,
          especie_nombre: m.especie_nombre,
          id_ubicacion_destino: m.id_ubicacion_destino || null,
          ubicacion_nombre: m.id_ubicacion_destino ? (m.ubicacion_destino_nombre || 'Planta propia') : (m.destino_nombre || 'Tercero (sin especificar)'),
          es_propia: !!m.id_ubicacion_destino,
          tn_con_precio: 0, valor_con_precio: 0,
          tn_a_fijar: 0,
          movs: []
        });
      }
      grupos.get(clave).movs.push(m);
    }

    const resultado = [];
    for (const g of grupos.values()) {
      let tnConPrecio = 0, valorConPrecio = 0, tnAFijar = 0;
      // Precio de referencia neto de flete para esta ubicacion (se calcula una sola vez por grupo)
      const refNeto = await precioNetoUbicacion(g.id_especie, g.id_ubicacion_destino, fecha);

      for (const m of g.movs) {
        const tn = parseFloat(m.kg_liquidables) / 1000;
        let precio = null;

        // Prioridad: si hay venta, manda el precio de venta (fijo o fijado).
        // Si no hay venta pero hay compra fija, se usa ese costo como valor.
        // En cualquier otro caso (a fijar sin fijar todavia), va a referencia.
        if (m.venta_tipo_precio === 'FIJO' && m.venta_precio_pactado !== null) {
          precio = parseFloat(m.venta_precio_pactado);
        } else if (m.venta_tipo_precio === 'A_FIJAR' && m.venta_precio_fijado !== null) {
          precio = parseFloat(m.venta_precio_fijado);
        } else if (!m.venta_tipo_precio && m.compra_tipo_precio === 'FIJO' && m.compra_precio_pactado !== null) {
          precio = parseFloat(m.compra_precio_pactado);
        } else if (!m.venta_tipo_precio && m.compra_tipo_precio === 'A_FIJAR' && m.compra_precio_fijado !== null) {
          precio = parseFloat(m.compra_precio_fijado);
        }

        if (precio !== null) {
          tnConPrecio += tn;
          valorConPrecio += tn * precio;
        } else {
          tnAFijar += tn;
        }
      }

      const valorAFijar = refNeto.precio !== null ? tnAFijar * refNeto.precio : null;

      resultado.push({
        especie_nombre: g.especie_nombre,
        ubicacion_nombre: g.ubicacion_nombre,
        es_propia: g.es_propia,
        toneladas_con_precio: Math.round(tnConPrecio * 1000) / 1000,
        valor_con_precio: Math.round(valorConPrecio * 100) / 100,
        toneladas_a_fijar: Math.round(tnAFijar * 1000) / 1000,
        precio_referencia_usado: refNeto.precio,
        ajustado_por_flete: refNeto.ajustadoPorFlete,
        precio_manual: refNeto.manual,
        valor_a_fijar: valorAFijar !== null ? Math.round(valorAFijar * 100) / 100 : null,
        valor_total: Math.round((valorConPrecio + (valorAFijar || 0)) * 100) / 100
      });
    }

    resultado.sort((a, b) => b.valor_total - a.valor_total);
    const totalGeneral = resultado.reduce((sum, r) => sum + r.valor_total, 0);

    res.json({ fecha, grupos: resultado, total_general: Math.round(totalGeneral * 100) / 100 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
