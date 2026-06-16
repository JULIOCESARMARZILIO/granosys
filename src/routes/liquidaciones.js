// liquidaciones.js
const router = require('express').Router();
const { pool } = require('../db');

router.get('/', async (req, res) => {
  try {
    const { modalidad, tipo, estado } = req.query;
    let query = `
      SELECT l.*, cp.razon_social as contraparte_nombre, c.numero_contrato,
             COALESCE((SELECT SUM(lm.kg_liquidables) FROM liquidacion_movimientos lm WHERE lm.id_liquidacion = l.id), 0) as kg_total
      FROM liquidaciones l
      LEFT JOIN contrapartes cp ON l.id_contraparte = cp.id
      LEFT JOIN contratos c ON l.id_contrato = c.id
      WHERE 1=1
    `;
    const params = [];
    if (modalidad) { params.push(modalidad); query += ` AND l.modalidad = $${params.length}`; }
    if (tipo) { params.push(tipo); query += ` AND l.tipo = $${params.length}`; }
    if (estado) { params.push(estado); query += ` AND l.estado = $${params.length}`; }
    query += ' ORDER BY l.created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { tipo, modalidad, tipo_liquidacion, id_contrato, id_contraparte,
            fecha_liquidacion, ids_movimientos, moneda } = req.body;

    // Verificar que ningún movimiento ya esté liquidado
    const { rows: yaLiq } = await pool.query(
      'SELECT id, numero_movimiento FROM movimientos WHERE id = ANY($1) AND estado_liquidacion = $2',
      [ids_movimientos, 'LIQUIDADO']
    );
    if (yaLiq.length > 0) {
      return res.status(400).json({
        error: `Los siguientes movimientos ya están liquidados: ${yaLiq.map(m => m.numero_movimiento).join(', ')}`
      });
    }

    // Generar número de liquidación
    const year = new Date().getFullYear();
    const { rows: last } = await pool.query(
      "SELECT nro_liquidacion FROM liquidaciones ORDER BY id DESC LIMIT 1"
    );
    const num = last[0] ? parseInt(last[0].nro_liquidacion.split('-')[2]) + 1 : 1;
    const nro_liquidacion = `LIQ-${year}-${String(num).padStart(4, '0')}`;

    // Obtener movimientos y calcular totales
    const { rows: movs } = await pool.query(
      'SELECT * FROM movimientos WHERE id = ANY($1)',
      [ids_movimientos]
    );

    // Obtener precio del contrato
    const { rows: contrato } = await pool.query('SELECT * FROM contratos WHERE id = $1', [id_contrato]);
    const precio = contrato[0]?.precio_pactado || 0;

    let monto_bruto = 0;
    for (const m of movs) {
      monto_bruto += (m.kg_liquidables || 0) * precio / 1000;
    }

    // Calcular total de descuentos por servicios asociados a los movimientos y aplicado_a = tipo
    const { rows: servRows } = await pool.query(
      'SELECT COALESCE(SUM(monto_real), 0) as total FROM servicios_movimiento WHERE id_movimiento = ANY($1) AND aplicado_a = $2',
      [ids_movimientos, tipo]
    );
    const total_descuentos_servicios = parseFloat(servRows[0].total) || 0;

    // Calcular monto neto a pagar
    const monto_neto_a_pagar = monto_bruto - total_descuentos_servicios;

    const { rows } = await pool.query(`
      INSERT INTO liquidaciones
        (nro_liquidacion, tipo, modalidad, tipo_liquidacion, id_contrato,
         id_contraparte, fecha_liquidacion, monto_bruto_total,
         total_descuentos_servicios, total_retenciones, monto_neto_a_pagar,
         moneda, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,'EMITIDA')
      RETURNING *
    `, [nro_liquidacion, tipo, modalidad, tipo_liquidacion||null,
        id_contrato, id_contraparte, fecha_liquidacion,
        monto_bruto, total_descuentos_servicios, monto_neto_a_pagar, moneda||'PESOS']);

    // Vincular movimientos a la liquidación
    for (const id_mov of ids_movimientos) {
      const mov = movs.find(m => m.id === id_mov);
      await pool.query(`
        INSERT INTO liquidacion_movimientos
          (id_liquidacion, id_movimiento, kg_liquidables, factor_aplicado, precio_aplicado, moneda, monto_bruto_parcial)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [rows[0].id, id_mov,
          mov.kg_liquidables, mov.factor_aplicado,
          precio, moneda||'PESOS',
          (mov.kg_liquidables || 0) * precio / 1000]);

      // Marcar movimiento como liquidado
      await pool.query(
        "UPDATE movimientos SET estado_liquidacion='LIQUIDADO', updated_at=NOW() WHERE id=$1",
        [id_mov]
      );
    }

    // Crear movimiento en cuenta corriente usando el neto
    const debeVal = tipo === 'COMPRA' ? 0 : monto_neto_a_pagar;
    const haberVal = tipo === 'COMPRA' ? monto_neto_a_pagar : 0;
    const saldoAcumulado = tipo === 'COMPRA' ? -monto_neto_a_pagar : monto_neto_a_pagar;

    await pool.query(`
      INSERT INTO cc_contrapartes
        (id_contraparte, id_liquidacion, id_contrato, fecha, tipo_movimiento,
         concepto, debe, haber, saldo_acumulado, modalidad, estado)
      VALUES ($1,$2,$3,$4,'LIQUIDACION',$5,$6,$7,$8,$9,'ABIERTO')
    `, [id_contraparte, rows[0].id, id_contrato, fecha_liquidacion,
        `Liquidación ${nro_liquidacion}`, debeVal, haberVal, saldoAcumulado, modalidad]);

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows: liq } = await pool.query(`
      SELECT l.*, cp.razon_social as contraparte_nombre, c.numero_contrato, cp.tipo_contraparte
      FROM liquidaciones l
      LEFT JOIN contrapartes cp ON l.id_contraparte = cp.id
      LEFT JOIN contratos c ON l.id_contrato = c.id
      WHERE l.id = $1
    `, [id]);
    if (!liq[0]) return res.status(404).json({ error: 'Liquidación no encontrada' });

    const { rows: movs } = await pool.query(`
      SELECT lm.*, m.numero_movimiento, m.patente_chasis, m.peso_neto_llegada_kg, m.humedad_llegada_pct
      FROM liquidacion_movimientos lm
      JOIN movimientos m ON lm.id_movimiento = m.id
      WHERE lm.id_liquidacion = $1
    `, [id]);

    res.json({ ...liq[0], movimientos: movs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { total_descuentos_servicios, total_retenciones, estado, observaciones } = req.body;

    await client.query('BEGIN');

    // 1. Obtener la liquidación actual
    const { rows: current } = await client.query('SELECT * FROM liquidaciones WHERE id = $1', [id]);
    if (!current[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Liquidación no encontrada' });
    }

    const monto_bruto = parseFloat(current[0].monto_bruto_total);
    const desc = parseFloat(total_descuentos_servicios) || 0;
    const ret = parseFloat(total_retenciones) || 0;
    const monto_neto_a_pagar = monto_bruto - desc - ret;

    // 2. Actualizar liquidación
    const { rows: updated } = await client.query(`
      UPDATE liquidaciones
      SET total_descuentos_servicios = $1,
          total_retenciones = $2,
          monto_neto_a_pagar = $3,
          estado = $4,
          observaciones = $5,
          updated_at = NOW()
      WHERE id = $6
      RETURNING *
    `, [desc, ret, monto_neto_a_pagar, estado || current[0].estado, observaciones, id]);

    // 3. Actualizar cuenta corriente
    const tipo = current[0].tipo;
    const debeVal = tipo === 'COMPRA' ? 0 : monto_neto_a_pagar;
    const haberVal = tipo === 'COMPRA' ? monto_neto_a_pagar : 0;
    const saldoAcumulado = tipo === 'COMPRA' ? -monto_neto_a_pagar : monto_neto_a_pagar;

    await client.query(`
      UPDATE cc_contrapartes
      SET debe = $1,
          haber = $2,
          saldo_acumulado = $3
      WHERE id_liquidacion = $4
    `, [debeVal, haberVal, saldoAcumulado, id]);

    await client.query('COMMIT');
    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query('BEGIN');

    // 1. Obtener la liquidación para verificar que existe
    const { rows: current } = await client.query('SELECT * FROM liquidaciones WHERE id = $1', [id]);
    if (!current[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Liquidación no encontrada' });
    }

    // 2. Restaurar estado de liquidación de los movimientos asociados
    await client.query(`
      UPDATE movimientos
      SET estado_liquidacion = 'ASIGNADO',
          updated_at = NOW()
      WHERE id IN (
        SELECT id_movimiento FROM liquidacion_movimientos WHERE id_liquidacion = $1
      )
    `, [id]);

    // 3. Eliminar de cc_contrapartes
    await client.query('DELETE FROM cc_contrapartes WHERE id_liquidacion = $1', [id]);

    // 4. Eliminar de liquidacion_movimientos
    await client.query('DELETE FROM liquidacion_movimientos WHERE id_liquidacion = $1', [id]);

    // 5. Eliminar de liquidaciones
    await client.query('DELETE FROM liquidaciones WHERE id = $1', [id]);

    await client.query('COMMIT');
    res.json({ success: true, message: "Liquidación eliminada correctamente" });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
