const { pool } = require('../db');

// Motor de stock: mantiene toneladas y costo promedio ponderado por
// ubicacion + especie + campana. Nunca lanza fuera de este archivo el
// calculo pisa datos previos a proposito (es un acumulador), asi que
// quien llame debe asegurarse de invocarlo una sola vez por evento real.

// Suma stock que entra (compra descargada, salida de una orden de
// produccion/maquila, etc). Si precioUnitario es null, se suma como
// tonelaje "a fijar" sin afectar el costo promedio (no se puede promediar
// un costo que todavia no existe).
async function sumarStock({ id_ubicacion, id_especie, id_campana, kg, precioUnitario }) {
  if (!id_ubicacion || !id_especie || !id_campana || !kg || kg <= 0) return;
  const toneladas = kg / 1000;
  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO stock (id_ubicacion, id_especie, id_campana, toneladas_totales, toneladas_con_precio, toneladas_a_fijar, costo_promedio_ponderado, valor_total)
      VALUES ($1,$2,$3,0,0,0,0,0)
      ON CONFLICT (id_ubicacion, id_especie, id_campana) DO NOTHING
    `, [id_ubicacion, id_especie, id_campana]);

    const { rows } = await client.query(
      `SELECT * FROM stock WHERE id_ubicacion=$1 AND id_especie=$2 AND id_campana=$3 FOR UPDATE`,
      [id_ubicacion, id_especie, id_campana]
    );
    const actual = rows[0];

    let nuevoConPrecio = parseFloat(actual.toneladas_con_precio);
    let nuevoAFijar = parseFloat(actual.toneladas_a_fijar);
    let nuevoValorTotal = parseFloat(actual.valor_total);
    let nuevoCostoPromedio = parseFloat(actual.costo_promedio_ponderado);

    if (precioUnitario !== null && precioUnitario !== undefined) {
      nuevoValorTotal += toneladas * precioUnitario;
      nuevoConPrecio += toneladas;
      nuevoCostoPromedio = nuevoConPrecio > 0 ? nuevoValorTotal / nuevoConPrecio : 0;
    } else {
      nuevoAFijar += toneladas;
    }

    await client.query(`
      UPDATE stock SET
        toneladas_totales = toneladas_totales + $1,
        toneladas_con_precio = $2,
        toneladas_a_fijar = $3,
        costo_promedio_ponderado = $4,
        valor_total = $5,
        updated_at = NOW()
      WHERE id_ubicacion=$6 AND id_especie=$7 AND id_campana=$8
    `, [toneladas, nuevoConPrecio, nuevoAFijar, nuevoCostoPromedio, nuevoValorTotal, id_ubicacion, id_especie, id_campana]);
  } finally {
    client.release();
  }
}

// Resta stock que sale (venta despachada, envio a maquila, etc). El costo
// promedio no cambia al restar (es la definicion de costeo por promedio
// ponderado); solo baja la cantidad y el valor total proporcionalmente.
async function restarStock({ id_ubicacion, id_especie, id_campana, kg }) {
  if (!id_ubicacion || !id_especie || !id_campana || !kg || kg <= 0) return;
  const toneladas = kg / 1000;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT * FROM stock WHERE id_ubicacion=$1 AND id_especie=$2 AND id_campana=$3 FOR UPDATE`,
      [id_ubicacion, id_especie, id_campana]
    );
    if (!rows[0]) return; // no habia stock registrado, nada para restar

    const actual = rows[0];
    const totalPrevio = parseFloat(actual.toneladas_totales);
    const nuevoTotal = Math.max(0, totalPrevio - toneladas);
    const proporcionRestante = totalPrevio > 0 ? nuevoTotal / totalPrevio : 0;

    const nuevoConPrecio = parseFloat(actual.toneladas_con_precio) * proporcionRestante;
    const nuevoAFijar = parseFloat(actual.toneladas_a_fijar) * proporcionRestante;
    const nuevoValorTotal = parseFloat(actual.valor_total) * proporcionRestante;

    await client.query(`
      UPDATE stock SET
        toneladas_totales = $1,
        toneladas_con_precio = $2,
        toneladas_a_fijar = $3,
        valor_total = $4,
        updated_at = NOW()
      WHERE id_ubicacion=$5 AND id_especie=$6 AND id_campana=$7
    `, [nuevoTotal, nuevoConPrecio, nuevoAFijar, nuevoValorTotal, id_ubicacion, id_especie, id_campana]);
  } finally {
    client.release();
  }
}

// Resta stock de la "bolsa" de una zona/sub-zona de referencia (ej. Rosario
// Norte), sin importar de que ubicacion puntual dentro de esa zona sale --
// se saca primero de la ubicacion con mas stock disponible, y si no alcanza,
// se sigue con la siguiente. Devuelve el detalle de que ubicaciones se usaron
// (para trazabilidad) y cuanto quedo sin poder cubrir (deberia ser 0 si se
// valido bien la disponibilidad antes de llamar).
async function restarStockPorZona({ zona, id_especie, id_campana, kg }) {
  const detalle = [];
  let kgRestante = kg;
  if (!zona || !id_especie || !id_campana || !kg || kg <= 0) return detalle;

  const { rows } = await pool.query(`
    SELECT s.id_ubicacion, u.nombre as ubicacion_nombre, s.toneladas_totales
    FROM stock s
    JOIN ubicaciones u ON s.id_ubicacion = u.id
    WHERE u.zona = $1 AND s.id_especie = $2 AND s.id_campana = $3 AND s.toneladas_totales > 0
    ORDER BY s.toneladas_totales DESC
  `, [zona, id_especie, id_campana]);

  for (const r of rows) {
    if (kgRestante <= 0) break;
    const disponibleKg = parseFloat(r.toneladas_totales) * 1000;
    const aSacarKg = Math.min(disponibleKg, kgRestante);
    if (aSacarKg <= 0) continue;
    await restarStock({ id_ubicacion: r.id_ubicacion, id_especie, id_campana, kg: aSacarKg });
    detalle.push({ id_ubicacion: r.id_ubicacion, ubicacion_nombre: r.ubicacion_nombre, kg: aSacarKg });
    kgRestante -= aSacarKg;
  }

  return { detalle, kgSinCubrir: Math.max(0, kgRestante) };
}

// Suma disponible en la bolsa de una zona (todas las ubicaciones que la
// integran), para validar antes de aplicar a un contrato.
async function stockDisponibleEnZona({ zona, id_especie, id_campana }) {
  const { rows } = await pool.query(`
    SELECT COALESCE(SUM(s.toneladas_totales), 0) as toneladas
    FROM stock s
    JOIN ubicaciones u ON s.id_ubicacion = u.id
    WHERE u.zona = $1 AND s.id_especie = $2 AND s.id_campana = $3
  `, [zona, id_especie, id_campana]);
  return parseFloat(rows[0].toneladas) || 0;
}

// "CUIT" de relleno que usan muchas contrapartes informales cargadas sin
// CUIT real -- si se matcheara por esto se mezclaria el grano de
// productores distintos como si fueran la misma persona.
const CUIT_RELLENO = '99999999999';

// Agrega a `params` la condicion SQL que identifica los movimientos de un
// productor puntual: por CUIT si esta cargado y no es el de relleno (mas
// confiable), si no por nombre (mismo criterio "soft" que ya se usaba en el
// frontend para sugerir contratos). Devuelve null si no se paso ningun dato
// de productor -- ahi el llamador no debe filtrar por productor.
function condicionProductor(params, cuitProductor, nombreProductor) {
  const cuitDigits = (cuitProductor || '').replace(/\D/g, '');
  if (cuitDigits && cuitDigits !== CUIT_RELLENO) {
    params.push(cuitDigits);
    return `regexp_replace(COALESCE(m.remitente_comercial_productor_cuit,''), '\\D', '', 'g') = $${params.length}`;
  }
  if (nombreProductor && nombreProductor.trim()) {
    params.push(`%${nombreProductor.trim()}%`);
    return `m.remitente_comercial_productor_nombre ILIKE $${params.length}`;
  }
  return null;
}

// Camiones (movimientos ya descargados) disponibles en la bolsa de una zona,
// con cuanto de su kg_liquidables todavia no fue aplicado a ningun contrato
// (se resta lo ya usado en aplicacion_stock_movimientos, nunca se cachea).
// Se usa tanto para mostrar la lista antes de aplicar como, con el mismo
// client de una transaccion, para el algoritmo de aplicacion en si --
// siempre por orden de llegada (FIFO), el mas viejo primero. Si se pasa
// cuitProductor/nombreProductor, se acota a los camiones de ese productor
// puntual (la bolsa deja de ser fungible entre productores distintos).
async function camionesDisponiblesEnZona({ zona, id_especie, id_campana, cuitProductor, nombreProductor }, dbClient = pool) {
  const params = [zona, id_especie, id_campana];
  let where = `u.zona = $1 AND m.id_especie = $2 AND m.id_campana = $3
        AND m.estado = 'DESCARGADO' AND m.kg_liquidables IS NOT NULL`;
  const condProd = condicionProductor(params, cuitProductor, nombreProductor);
  if (condProd) where += ` AND ${condProd}`;

  const { rows } = await dbClient.query(`
    SELECT * FROM (
      SELECT m.id, m.numero_movimiento, m.fecha_descarga, m.kg_liquidables, m.id_ubicacion_destino,
             u.nombre AS ubicacion_destino_nombre,
             m.kg_liquidables - COALESCE((
               SELECT SUM(kg_aplicados) FROM aplicacion_stock_movimientos WHERE id_movimiento = m.id
             ), 0) AS kg_disponible
      FROM movimientos m
      JOIN ubicaciones u ON u.id = m.id_ubicacion_destino
      WHERE ${where}
    ) t
    WHERE kg_disponible > 0.001
    ORDER BY fecha_descarga ASC NULLS LAST, id ASC
  `, params);
  return rows;
}

// Toneladas disponibles de un productor puntual, agrupadas por zona (en
// todas las zonas donde tenga camiones descargados sin aplicar todavia).
// Es lo que arma la vista "Asignar mercadería" del lado de Contratos: elegis
// un productor y ves de una en que zonas tiene stock y cuanto.
async function productorPorZona({ id_especie, id_campana, cuitProductor, nombreProductor }, dbClient = pool) {
  const params = [id_especie, id_campana];
  let where = `m.id_especie = $1 AND m.id_campana = $2 AND m.estado = 'DESCARGADO'
        AND m.kg_liquidables IS NOT NULL AND u.zona IS NOT NULL`;
  const condProd = condicionProductor(params, cuitProductor, nombreProductor);
  if (!condProd) return [];
  where += ` AND ${condProd}`;

  const { rows } = await dbClient.query(`
    SELECT u.zona,
           SUM(m.kg_liquidables - COALESCE((
             SELECT SUM(kg_aplicados) FROM aplicacion_stock_movimientos WHERE id_movimiento = m.id
           ), 0)) AS kg_disponible
    FROM movimientos m
    JOIN ubicaciones u ON u.id = m.id_ubicacion_destino
    WHERE ${where}
    GROUP BY u.zona
    HAVING SUM(m.kg_liquidables - COALESCE((
      SELECT SUM(kg_aplicados) FROM aplicacion_stock_movimientos WHERE id_movimiento = m.id
    ), 0)) > 0.001
    ORDER BY u.zona
  `, params);
  return rows.map(r => ({ zona: r.zona, toneladas_disponible: parseFloat(r.kg_disponible) / 1000 }));
}

module.exports = { sumarStock, restarStock, restarStockPorZona, stockDisponibleEnZona, camionesDisponiblesEnZona, productorPorZona };
