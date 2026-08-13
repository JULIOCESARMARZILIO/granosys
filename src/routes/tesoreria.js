const router = require('express').Router();
const { pool } = require('../db');

const MEDIOS_PAGO = new Set(['TRANSFERENCIA', 'CHEQUE_PROPIO', 'CHEQUE_TERCEROS', 'EFECTIVO', 'OTRO']);
const MODALIDADES = new Set(['FORMAL', 'INFORMAL']);
const ESTADOS_CHEQUE = new Set(['EMITIDO', 'EN_CARTERA', 'ENDOSADO', 'DEPOSITADO', 'ACREDITADO', 'RECHAZADO', 'ANULADO']);

router.get('/cuentas-bancarias', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, nombre, banco, tipo_cuenta, numero_cuenta, cbu, alias, moneda,
             proveedor_conexion, external_account_id, conexion_estado,
             ultima_sincronizacion, activa, created_at, updated_at
      FROM cuentas_bancarias
      WHERE activa=TRUE
      ORDER BY banco, nombre
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cuentas-bancarias', async (req, res) => {
  try {
    const { nombre, banco, tipo_cuenta, numero_cuenta, cbu, alias, moneda } = req.body;
    if (!nombre || !banco) return res.status(400).json({ error: 'Nombre y banco son obligatorios' });
    if (cbu && !/^\d{22}$/.test(String(cbu))) return res.status(400).json({ error: 'El CBU debe tener 22 dígitos' });

    const { rows } = await pool.query(`
      INSERT INTO cuentas_bancarias
        (nombre,banco,tipo_cuenta,numero_cuenta,cbu,alias,moneda)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [nombre, banco, tipo_cuenta || null, numero_cuenta || null, cbu || null,
      alias || null, moneda || 'PESOS']);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una cuenta con ese CBU' });
    res.status(500).json({ error: err.message });
  }
});

router.get('/cheques', async (req, res) => {
  try {
    const params = [];
    const conditions = [];
    if (req.query.estado) {
      if (!ESTADOS_CHEQUE.has(req.query.estado)) return res.status(400).json({ error: 'Estado de cheque inválido' });
      params.push(req.query.estado);
      conditions.push(`ch.estado=$${params.length}`);
    }
    const { rows } = await pool.query(`
      SELECT ch.*, mt.tipo AS movimiento_tipo, mt.id_contraparte,
             cp.razon_social AS contraparte
      FROM cheques_tesoreria ch
      JOIN movimientos_tesoreria mt ON mt.id=ch.id_movimiento_tesoreria
      LEFT JOIN contrapartes cp ON cp.id=mt.id_contraparte
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY ch.fecha_pago, ch.id
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/cheques/:id/estado', async (req, res) => {
  try {
    const { estado } = req.body;
    if (!ESTADOS_CHEQUE.has(estado)) return res.status(400).json({ error: 'Estado de cheque inválido' });
    const { rows } = await pool.query(`
      UPDATE cheques_tesoreria SET estado=$1, updated_at=NOW()
      WHERE id=$2 AND estado <> 'ANULADO' RETURNING *
    `, [estado, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Cheque no encontrado o anulado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/movimientos', async (req, res) => {
  try {
    const params = [];
    const conditions = [];
    if (req.query.id_contraparte) {
      params.push(req.query.id_contraparte);
      conditions.push(`mt.id_contraparte=$${params.length}`);
    }
    params.push(Math.max(1, Math.min(500, Number(req.query.limite) || 100)));
    const { rows } = await pool.query(`
      SELECT mt.*, cp.razon_social AS contraparte, cb.nombre AS cuenta_bancaria,
             COALESCE(SUM(a.importe),0) AS importe_aplicado
      FROM movimientos_tesoreria mt
      LEFT JOIN contrapartes cp ON cp.id=mt.id_contraparte
      LEFT JOIN cuentas_bancarias cb ON cb.id=mt.id_cuenta_bancaria
      LEFT JOIN aplicaciones_tesoreria a ON a.id_movimiento_tesoreria=mt.id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      GROUP BY mt.id, cp.razon_social, cb.nombre
      ORDER BY mt.fecha DESC, mt.id DESC
      LIMIT $${params.length}
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/movimientos', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      id_contraparte, id_cuenta_bancaria, fecha, fecha_valor, tipo,
      medio_pago, importe, moneda, cotizacion, referencia, metadata, modalidad = 'FORMAL', cheque,
      aplicaciones = []
    } = req.body;
    const valor = Number(importe);
    if (!id_contraparte || !fecha || !['PAGO', 'COBRO'].includes(tipo) || !MEDIOS_PAGO.has(medio_pago)) {
      return res.status(400).json({ error: 'Contraparte, fecha, tipo y medio de pago válidos son obligatorios' });
    }
    if (!Number.isFinite(valor) || valor <= 0) return res.status(400).json({ error: 'El importe debe ser positivo' });
    if (!MODALIDADES.has(modalidad)) return res.status(400).json({ error: 'Modalidad inválida' });
    if (medio_pago === 'TRANSFERENCIA' && !id_cuenta_bancaria) {
      return res.status(400).json({ error: 'La transferencia requiere una cuenta bancaria' });
    }
    const esCheque = medio_pago === 'CHEQUE_PROPIO' || medio_pago === 'CHEQUE_TERCEROS';
    if (esCheque && (!cheque?.numero || !cheque?.banco || !cheque?.fecha_pago)) {
      return res.status(400).json({ error: 'El cheque requiere número, banco y fecha de pago' });
    }
    const totalAplicado = aplicaciones.reduce((total, item) => total + Number(item.importe || 0), 0);
    if (aplicaciones.some(item => !item.id_liquidacion || Number(item.importe) <= 0) || totalAplicado > valor + 0.0001) {
      return res.status(400).json({ error: 'Las aplicaciones deben ser positivas y no superar el importe del movimiento' });
    }

    await client.query('BEGIN');
    if (id_cuenta_bancaria) {
      const cuenta = await client.query('SELECT id FROM cuentas_bancarias WHERE id=$1 AND activa=TRUE', [id_cuenta_bancaria]);
      if (!cuenta.rows[0]) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 404 });
    }
    for (const aplicacion of aplicaciones) {
      const liquidacion = await client.query(
        `SELECT l.id, l.monto_neto_a_pagar,
                (SELECT COALESCE(SUM(a.importe),0)
                 FROM aplicaciones_tesoreria a
                 WHERE a.id_liquidacion=l.id) AS aplicado
         FROM liquidaciones l
         WHERE l.id=$1 AND l.id_contraparte=$2 AND l.modalidad=$3
         FOR UPDATE OF l`,
        [aplicacion.id_liquidacion, id_contraparte, modalidad]
      );
      if (!liquidacion.rows[0]) throw Object.assign(new Error('La liquidación no pertenece a la contraparte'), { status: 400 });
      const disponible = Number(liquidacion.rows[0].monto_neto_a_pagar) - Number(liquidacion.rows[0].aplicado);
      if (Number(aplicacion.importe) > disponible + 0.0001) {
        throw Object.assign(new Error('La aplicación supera el saldo pendiente de la liquidación'), { status: 400 });
      }
    }

    const debe = tipo === 'PAGO' ? valor : 0;
    const haber = tipo === 'COBRO' ? valor : 0;
    const { rows: ccRows } = await client.query(`
      INSERT INTO cc_contrapartes
        (id_contraparte,fecha,tipo_movimiento,concepto,debe,haber,saldo_acumulado,modalidad,estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ABIERTO') RETURNING id
    `, [id_contraparte, fecha, tipo, referencia || `${medio_pago} ${tipo}`, debe, haber, debe - haber, modalidad]);

    const { rows } = await client.query(`
      INSERT INTO movimientos_tesoreria
        (id_contraparte,id_cuenta_bancaria,id_cc_movimiento,fecha,fecha_valor,tipo,
         medio_pago,importe,moneda,cotizacion,referencia,metadata,creado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
      RETURNING *
    `, [id_contraparte, id_cuenta_bancaria || null, ccRows[0].id, fecha,
      fecha_valor || null, tipo, medio_pago, valor, moneda || 'PESOS', cotizacion || null,
      referencia || null, JSON.stringify(metadata || {}), req.user?.id || null]);

    for (const aplicacion of aplicaciones) {
      await client.query(`
        INSERT INTO aplicaciones_tesoreria (id_movimiento_tesoreria,id_liquidacion,importe)
        VALUES ($1,$2,$3)
      `, [rows[0].id, aplicacion.id_liquidacion, aplicacion.importe]);
    }
    if (esCheque) {
      const tipoCheque = cheque.tipo || (medio_pago === 'CHEQUE_PROPIO' ? 'PROPIO' : 'TERCERO');
      if (!['PROPIO', 'TERCERO', 'ECHEQ'].includes(tipoCheque)) {
        throw Object.assign(new Error('Tipo de cheque inválido'), { status: 400 });
      }
      if (cheque.cuit_librador && !/^\d{11}$/.test(String(cheque.cuit_librador).replace(/\D/g, ''))) {
        throw Object.assign(new Error('CUIT del librador inválido'), { status: 400 });
      }
      await client.query(`
        INSERT INTO cheques_tesoreria
          (id_movimiento_tesoreria,tipo,numero,banco,librador,cuit_librador,
           fecha_emision,fecha_pago,importe,moneda,estado,observaciones)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [rows[0].id, tipoCheque, cheque.numero, cheque.banco, cheque.librador || null,
        cheque.cuit_librador ? String(cheque.cuit_librador).replace(/\D/g, '') : null,
        cheque.fecha_emision || null, cheque.fecha_pago, valor, moneda || 'PESOS',
        cheque.estado || (tipoCheque === 'PROPIO' ? 'EMITIDO' : 'EN_CARTERA'), cheque.observaciones || null]);
    }
    await client.query('COMMIT');
    res.status(201).json({ ...rows[0], importe_aplicado: totalAplicado });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
