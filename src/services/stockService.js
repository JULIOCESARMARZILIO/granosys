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

module.exports = { sumarStock, restarStock };
