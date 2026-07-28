const router = require('express').Router();
const { pool } = require('../db');
const { precioNetoUbicacion, precioVigente } = require('../services/preciosService');

// GET /api/posicion/consolidada
// Todo lo que todavia no esta liquidado (sin importar en que planta este,
// propia o de un tercero), valuado: al precio de venta si ya esta vendido
// y fijado; al precio de referencia neto de flete si esta a fijar (de
// venta o de compra); nunca al costo de compra si ya hay venta (ahi manda
// el precio de venta, aunque no este fijado, se usa referencia).
// Convierte un diferencial de fijacion (que puede venir en USD, ARS o "LLENO",
// tal como se pacto en el contrato) a un ajuste en pesos sobre el precio de
// referencia/pizarra. LLENO significa que el diferencial ya es el precio
// completo pactado en pesos, no un ajuste sobre otra base.
function ajusteDiferencialEnPesos(diferencial, tipoDiferencial, dolarOficial) {
  if (diferencial === null || diferencial === undefined || !tipoDiferencial) return null;
  const valor = parseFloat(diferencial);
  if (tipoDiferencial === 'USD') return dolarOficial ? valor * dolarOficial : null;
  if (tipoDiferencial === 'ARS') return valor;
  return null; // LLENO se trata aparte (precio directo, no ajuste)
}

router.get('/consolidada', async (req, res) => {
  try {
    const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);

    const { rows: cotizRows } = await pool.query(
      'SELECT dolar_oficial FROM cotizaciones WHERE fecha <= $1 ORDER BY fecha DESC LIMIT 1',
      [fecha]
    );
    const dolarOficial = cotizRows[0] ? parseFloat(cotizRows[0].dolar_oficial) : null;

    const { rows: movs } = await pool.query(`
      SELECT
        m.id, m.kg_liquidables, m.id_especie,
        e.nombre as especie_nombre,
        m.id_ubicacion_destino,
        ud.nombre as ubicacion_destino_nombre,
        m.destino_nombre,
        cc.tipo_precio as compra_tipo_precio, cc.precio_pactado as compra_precio_pactado, cc.precio_fijado as compra_precio_fijado,
        cc.diferencial_fijacion as compra_diferencial, cc.tipo_diferencial as compra_tipo_diferencial,
        cv.tipo_precio as venta_tipo_precio, cv.precio_pactado as venta_precio_pactado, cv.precio_fijado as venta_precio_fijado,
        cv.diferencial_fijacion as venta_diferencial, cv.tipo_diferencial as venta_tipo_diferencial
      FROM movimientos m
      JOIN especies e ON m.id_especie = e.id
      LEFT JOIN ubicaciones ud ON m.id_ubicacion_destino = ud.id
      LEFT JOIN contratos cc ON m.id_contrato_compra = cc.id
      LEFT JOIN contratos cv ON m.id_contrato_venta = cv.id
      WHERE m.estado_liquidacion != 'LIQUIDADO'
        AND m.kg_liquidables IS NOT NULL
        AND ($1::text IS NULL OR m.modalidad = $1)
    `, [req.query.modalidad || null]);

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
      let tnConPrecio = 0, valorConPrecio = 0, tnAFijar = 0, valorAFijar = 0;
      let huboAFijarSinValuar = 0;
      // Precio de referencia (pizarra) neto de flete para esta ubicacion
      const refNeto = await precioNetoUbicacion(g.id_especie, g.id_ubicacion_destino, fecha);

      for (const m of g.movs) {
        const tn = parseFloat(m.kg_liquidables) / 1000;
        let precio = null;

        // Prioridad: si hay venta, manda el precio de venta (fijo o fijado).
        // Si no hay venta pero hay compra fija, se usa ese costo como valor.
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
          continue;
        }

        // Todavia a fijar: si el contrato (venta si existe, si no compra) tiene
        // su propio diferencial de fijacion pactado, se usa ese en vez del
        // precio de referencia generico (es mas preciso, es lo que realmente
        // se acordo con esa contraparte).
        tnAFijar += tn;
        const diferencial = m.venta_diferencial ?? m.compra_diferencial;
        const tipoDiferencial = m.venta_diferencial != null ? m.venta_tipo_diferencial : m.compra_tipo_diferencial;

        let precioAFijar = null;
        if (tipoDiferencial === 'LLENO' && diferencial !== null) {
          precioAFijar = parseFloat(diferencial);
        } else {
          const ajuste = ajusteDiferencialEnPesos(diferencial, tipoDiferencial, dolarOficial);
          if (ajuste !== null && refNeto.precio !== null) {
            precioAFijar = refNeto.precio + ajuste;
          } else if (refNeto.precio !== null) {
            precioAFijar = refNeto.precio;
          }
        }

        if (precioAFijar !== null) {
          valorAFijar += tn * precioAFijar;
        } else {
          huboAFijarSinValuar += tn;
        }
      }

      resultado.push({
        especie_nombre: g.especie_nombre,
        ubicacion_nombre: g.ubicacion_nombre,
        es_propia: g.es_propia,
        toneladas_con_precio: Math.round(tnConPrecio * 1000) / 1000,
        valor_con_precio: Math.round(valorConPrecio * 100) / 100,
        toneladas_a_fijar: Math.round(tnAFijar * 1000) / 1000,
        toneladas_a_fijar_sin_valuar: Math.round(huboAFijarSinValuar * 1000) / 1000,
        precio_referencia_usado: refNeto.precio,
        ajustado_por_flete: refNeto.ajustadoPorFlete,
        precio_manual: refNeto.manual,
        valor_a_fijar: Math.round(valorAFijar * 100) / 100,
        valor_total: Math.round((valorConPrecio + valorAFijar) * 100) / 100
      });
    }

    resultado.sort((a, b) => b.valor_total - a.valor_total);
    const totalGeneral = resultado.reduce((sum, r) => sum + r.valor_total, 0);

    res.json({ fecha, grupos: resultado, total_general: Math.round(totalGeneral * 100) / 100 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/posicion/capacidad-pago?id_especie=1&costo_molienda=50000&moneda=ARS
// Capacidad teorica de pago: cuanto se puede pagar como maximo por el grano
// para que, despues de convertirlo en subproductos (segun el rendimiento
// teorico de cada uno) y descontar el costo de molienda, siga siendo
// rentable. Comprar por encima de este precio pierde plata; por debajo, gana.
router.get('/capacidad-pago', async (req, res) => {
  try {
    const idEspecie = parseInt(req.query.id_especie);
    const costoMolienda = parseFloat(req.query.costo_molienda) || 0;
    const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);
    if (!idEspecie) return res.status(400).json({ error: 'id_especie es obligatorio' });

    const { rows: subproductos } = await pool.query(
      `SELECT id, nombre, rendimiento_teorico_pct FROM especies
       WHERE id_especie_origen = $1 AND tipo_producto = 'SUBPRODUCTO' AND rendimiento_teorico_pct IS NOT NULL`,
      [idEspecie]
    );

    if (subproductos.length === 0) {
      return res.status(400).json({ error: 'Este producto no tiene subproductos con rendimiento teorico cargado (Configuracion > Especies).' });
    }

    let ingresoTeoricoPorTon = 0;
    const detalle = [];
    let faltaAlgunPrecio = false;
    for (const sp of subproductos) {
      const ref = await precioVigente(sp.id, fecha);
      const rendimiento = parseFloat(sp.rendimiento_teorico_pct) / 100;
      if (!ref) {
        faltaAlgunPrecio = true;
        detalle.push({ especie_nombre: sp.nombre, rendimiento_pct: sp.rendimiento_teorico_pct, precio_referencia: null, aporte_por_ton: null });
        continue;
      }
      const aportePorTon = rendimiento * parseFloat(ref.precio);
      ingresoTeoricoPorTon += aportePorTon;
      detalle.push({ especie_nombre: sp.nombre, rendimiento_pct: sp.rendimiento_teorico_pct, precio_referencia: parseFloat(ref.precio), aporte_por_ton: Math.round(aportePorTon * 100) / 100 });
    }

    const capacidadPago = ingresoTeoricoPorTon - costoMolienda;

    res.json({
      id_especie: idEspecie,
      fecha,
      costo_molienda: costoMolienda,
      ingreso_teorico_por_ton: Math.round(ingresoTeoricoPorTon * 100) / 100,
      capacidad_pago_por_ton: Math.round(capacidadPago * 100) / 100,
      falta_algun_precio: faltaAlgunPrecio,
      detalle
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/posicion/exposicion-neta
// Posicion neta abierta al riesgo de precio, por producto: toneladas
// compradas "a fijar" (sin precio cerrado todavia) menos toneladas
// vendidas "a fijar". Si da positivo, estas "largo" (comprado neto, te
// perjudica que el precio baje); si da negativo, estas "corto" (vendido
// neto, te perjudica que el precio suba). Usa fijaciones_contrato para
// descontar lo que ya se fue fijando parcialmente de cada contrato.
router.get('/exposicion-neta', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        c.id, c.tipo_contrato, c.id_especie, e.nombre as especie_nombre,
        c.cantidad_toneladas_pactadas,
        COALESCE((SELECT SUM(f.cantidad_toneladas) FROM fijaciones_contrato f WHERE f.id_contrato = c.id), 0) as toneladas_fijadas
      FROM contratos c
      JOIN especies e ON c.id_especie = e.id
      WHERE c.tipo_precio = 'A_FIJAR'
        AND c.activo = TRUE
        AND c.estado NOT IN ('CANCELADO')
        AND ($1::text IS NULL OR c.modalidad = $1)
    `, [req.query.modalidad || null]);

    const porEspecie = new Map();
    for (const c of rows) {
      const abierto = Math.max(0, parseFloat(c.cantidad_toneladas_pactadas) - parseFloat(c.toneladas_fijadas));
      if (abierto <= 0) continue;
      if (!porEspecie.has(c.id_especie)) {
        porEspecie.set(c.id_especie, { especie_nombre: c.especie_nombre, tn_compradas_a_fijar: 0, tn_vendidas_a_fijar: 0 });
      }
      const grupo = porEspecie.get(c.id_especie);
      if (c.tipo_contrato === 'COMPRA') grupo.tn_compradas_a_fijar += abierto;
      else if (c.tipo_contrato === 'VENTA') grupo.tn_vendidas_a_fijar += abierto;
    }

    const resultado = Array.from(porEspecie.values()).map(g => ({
      especie_nombre: g.especie_nombre,
      tn_compradas_a_fijar: Math.round(g.tn_compradas_a_fijar * 1000) / 1000,
      tn_vendidas_a_fijar: Math.round(g.tn_vendidas_a_fijar * 1000) / 1000,
      posicion_neta: Math.round((g.tn_compradas_a_fijar - g.tn_vendidas_a_fijar) * 1000) / 1000
    })).sort((a, b) => Math.abs(b.posicion_neta) - Math.abs(a.posicion_neta));

    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
