const { pool } = require('../db');

// Recalcula y actualiza la cantidad de toneladas asignadas y el estado de un
// contrato. Unificada aca porque estaba triplicada (identica) en agent.js,
// contratos.js y movimientos.js -- cualquier cambio futuro se hace en un
// solo lugar.
//
// Suma tres fuentes, todas independientes entre si:
// 1) El movimiento "principal" de cada lado (movimientos.id_contrato_compra/
//    venta + kg_asignados_contrato_compra/venta) -- el caso de siempre, un
//    contrato por lado.
// 2) contrato_aplicaciones_stock (solo COMPRA) -- lo aplicado desde la
//    Bolsa por Zona.
// 3) movimiento_contrato_extra -- contratos ADICIONALES de un mismo lado
//    cuando un movimiento se reparte entre mas de un contrato de compra o
//    de venta (ver ruta /api/movimientos/:id/asignar-extra).
async function recalcularContrato(id_contrato) {
  if (!id_contrato) return;
  const client = await pool.connect();
  try {
    const { rows: contractRows } = await client.query(
      'SELECT tipo_contrato, cantidad_toneladas_pactadas, base_calculo_peso FROM contratos WHERE id = $1',
      [id_contrato]
    );
    if (contractRows.length === 0) return;
    const { tipo_contrato, cantidad_toneladas_pactadas, base_calculo_peso } = contractRows[0];

    let fieldToSum = 'peso_neto_salida_kg';
    if (base_calculo_peso === 'BRUTO_DESCARGA') {
      fieldToSum = 'peso_neto_llegada_kg';
    } else if (base_calculo_peso === 'NETO_ACONDICIONADO') {
      fieldToSum = 'kg_liquidables';
    }

    let sumQuery = '';
    if (tipo_contrato === 'COMPRA') {
      sumQuery = `SELECT COALESCE(SUM(COALESCE(kg_asignados_contrato_compra, ${fieldToSum})), 0) as total_kg FROM movimientos WHERE id_contrato_compra = $1`;
    } else {
      sumQuery = `SELECT COALESCE(SUM(COALESCE(kg_asignados_contrato_venta, ${fieldToSum})), 0) as total_kg FROM movimientos WHERE id_contrato_venta = $1`;
    }

    const { rows: sumRows } = await client.query(sumQuery, [id_contrato]);
    let total_toneladas = parseFloat(sumRows[0].total_kg) / 1000;

    if (tipo_contrato === 'COMPRA') {
      const { rows: aplicRows } = await client.query(
        'SELECT COALESCE(SUM(toneladas), 0) as total FROM contrato_aplicaciones_stock WHERE id_contrato = $1',
        [id_contrato]
      );
      total_toneladas += parseFloat(aplicRows[0].total);
    }

    const { rows: extraRows } = await client.query(
      'SELECT COALESCE(SUM(kg_aplicados), 0) as total_kg FROM movimiento_contrato_extra WHERE id_contrato = $1 AND tipo_contrato = $2',
      [id_contrato, tipo_contrato]
    );
    total_toneladas += parseFloat(extraRows[0].total_kg) / 1000;

    let estado = 'CONFIRMADO';
    if (total_toneladas >= parseFloat(cantidad_toneladas_pactadas)) {
      estado = 'CUMPLIDO';
    } else if (total_toneladas > 0) {
      estado = 'EN_CURSO';
    }

    await client.query(
      `UPDATE contratos SET
         cantidad_toneladas_asignadas = $1,
         estado = $2,
         updated_at = NOW()
       WHERE id = $3`,
      [total_toneladas, estado, id_contrato]
    );
  } catch (err) {
    console.error(`Error al recalcular contrato ${id_contrato}:`, err);
  } finally {
    client.release();
  }
}

module.exports = { recalcularContrato };
