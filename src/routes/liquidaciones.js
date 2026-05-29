// liquidaciones.js
const router = require('express').Router();
const { pool } = require('../db');

router.get('/', async (req, res) => {
  try {
    const { modalidad, tipo, estado } = req.query;
    let query = `
      SELECT l.*, cp.razon_social as contraparte_nombre, c.numero_contrato
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

    const { rows } = await pool.query(`
      INSERT INTO liquidaciones
        (nro_liquidacion, tipo, modalidad, tipo_liquidacion, id_contrato,
         id_contraparte, fecha_liquidacion, monto_bruto_total,
         total_descuentos_servicios, total_retenciones, monto_neto_a_pagar,
         moneda, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0,$8,$9,'EMITIDA')
      RETURNING *
    `, [nro_liquidacion, tipo, modalidad, tipo_liquidacion||null,
        id_contrato, id_contraparte, fecha_liquidacion,
        monto_bruto, moneda||'PESOS']);

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

    // Crear movimiento en cuenta corriente
    await pool.query(`
      INSERT INTO cc_contrapartes
        (id_contraparte, id_liquidacion, id_contrato, fecha, tipo_movimiento,
         concepto, debe, haber, saldo_acumulado, modalidad, estado)
      VALUES ($1,$2,$3,$4,'LIQUIDACION',$5,$6,0,$6,$7,'ABIERTO')
    `, [id_contraparte, rows[0].id, id_contrato, fecha_liquidacion,
        `Liquidación ${nro_liquidacion}`, monto_bruto, modalidad]);

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
