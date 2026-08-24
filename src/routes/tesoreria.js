const router = require('express').Router();
const { pool } = require('../db');
const { registrarAuditoria } = require('../services/auditoria');

const MEDIOS_PAGO = new Set(['TRANSFERENCIA', 'CHEQUE_PROPIO', 'CHEQUE_TERCEROS', 'EFECTIVO', 'OTRO']);
const MODALIDADES = new Set(['FORMAL', 'INFORMAL']);
const ESTADOS_CHEQUE = new Set(['EMITIDO', 'EN_CARTERA', 'TRANSFERIDO', 'DEVUELTO', 'ENDOSADO', 'ENTREGADO', 'DEPOSITADO', 'ACREDITADO', 'RECHAZADO', 'ANULADO']);
const CLASES_ORDEN = new Set(['PAGO_PROVEEDOR', 'PAGO_PROPIO']);
const MEDIOS_ORDEN = new Set(['TRANSFERENCIA', 'CHEQUE_PROPIO', 'CHEQUE_TERCEROS', 'ECHEQ', 'EFECTIVO', 'OTRO']);

function numero(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

function chequeMedio(medio) {
  return ['CHEQUE_PROPIO', 'CHEQUE_TERCEROS', 'ECHEQ'].includes(medio);
}

function medioPersistido(medio) {
  return medio === 'ECHEQ' ? 'CHEQUE_TERCEROS' : medio;
}

function tipoCheque(instrumento) {
  if (instrumento.medio_pago === 'ECHEQ') return 'ECHEQ';
  return instrumento.cheque?.tipo || (instrumento.medio_pago === 'CHEQUE_PROPIO' ? 'PROPIO' : 'TERCERO');
}

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
  const client = await pool.connect();
  try {
    const { estado, entregado_por, recibido_por, observaciones } = req.body;
    if (!ESTADOS_CHEQUE.has(estado)) return res.status(400).json({ error: 'Estado de cheque inválido' });
    if (['TRANSFERIDO','DEVUELTO','ENDOSADO','ENTREGADO'].includes(estado) && (!entregado_por || !recibido_por)) {
      return res.status(400).json({ error: 'Debe indicar quién entrega y quién recibe el cheque' });
    }
    await client.query('BEGIN');
    const { rows } = await client.query(`
      UPDATE cheques_tesoreria SET estado=$1, updated_at=NOW()
      WHERE id=$2 AND estado <> 'ANULADO' RETURNING *
    `, [estado, req.params.id]);
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cheque no encontrado o anulado' });
    }
    const { rows: origen } = await client.query(`
      SELECT mt.id, mt.id_orden_pago, mt.modalidad, mt.id_contraparte
      FROM movimientos_tesoreria mt
      WHERE mt.id=$1
    `, [rows[0].id_movimiento_tesoreria]);
    if (origen[0]?.id_orden_pago) {
      await client.query(`
        INSERT INTO trazabilidad_instrumentos_pago
          (id_orden_pago,id_movimiento_tesoreria,id_cheque,evento,modalidad_origen,
           entregado_por,recibido_por,observaciones,creado_por)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [origen[0].id_orden_pago, origen[0].id, rows[0].id, `CHEQUE_${estado}`,
        origen[0].modalidad, entregado_por || null, recibido_por || null,
        observaciones || null, req.user?.id || null]);
    }
    await client.query('COMMIT');
    await registrarAuditoria(req, {
      accion: 'CAMBIAR_ESTADO', modulo: 'tesoreria_cheques', registro_id: rows[0].id,
      datos_despues: { estado, entregado_por, recibido_por, observaciones }
    });
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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

// ── TESORERIA CENTRAL / ORDENES DE PAGO ────────────────────────────────

router.get('/conceptos-fiscales', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM conceptos_fiscales_tesoreria
      WHERE activo=TRUE
      ORDER BY categoria, nombre
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/conceptos-fiscales', async (req, res) => {
  try {
    const { codigo, nombre, categoria, naturaleza, alicuota_default, vigente_desde, vigente_hasta } = req.body;
    const categorias = new Set(['IVA','GANANCIAS','RETENCION_IVA','RETENCION_GANANCIAS','INGRESOS_BRUTOS','SUSS','OTRO']);
    const naturalezas = new Set(['ADICION','RETENCION','INFORMATIVO']);
    if (!codigo || !nombre || !categorias.has(categoria) || !naturalezas.has(naturaleza)) {
      return res.status(400).json({ error: 'Codigo, nombre, categoria y naturaleza validos son obligatorios' });
    }
    const { rows } = await pool.query(`
      INSERT INTO conceptos_fiscales_tesoreria
        (codigo,nombre,categoria,naturaleza,alicuota_default,vigente_desde,vigente_hasta)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [String(codigo).trim().toUpperCase(), String(nombre).trim(), categoria, naturaleza,
      alicuota_default === '' || alicuota_default == null ? null : numero(alicuota_default),
      vigente_desde || null, vigente_hasta || null]);
    await registrarAuditoria(req, { accion: 'CREAR', modulo: 'tesoreria_conceptos_fiscales', registro_id: rows[0].id, datos_despues: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un concepto con ese codigo' });
    res.status(500).json({ error: err.message });
  }
});

router.get('/resumen', async (_req, res) => {
  try {
    const [ordenes, cheques, propio] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(SUM(importe_total) FILTER (WHERE clase_pago='PAGO_PROVEEDOR' AND estado<>'ANULADA'),0) AS pagos_proveedores,
          COALESCE(SUM(importe_total) FILTER (WHERE clase_pago='PAGO_PROPIO' AND estado<>'ANULADA'),0) AS pagos_propios,
          COUNT(*) FILTER (WHERE estado='PAGADA') AS ordenes_pagadas
        FROM ordenes_pago
      `),
      pool.query(`
        SELECT COUNT(*) FILTER (WHERE estado IN ('EMITIDO','EN_CARTERA','TRANSFERIDO')) AS en_cartera,
               COALESCE(SUM(importe) FILTER (WHERE estado IN ('EMITIDO','EN_CARTERA','TRANSFERIDO')),0) AS importe_cartera,
               COUNT(*) FILTER (WHERE fecha_pago<CURRENT_DATE AND estado NOT IN ('ACREDITADO','ANULADO')) AS vencidos
        FROM cheques_tesoreria
      `),
      pool.query(`
        SELECT COALESCE(SUM(mt.importe-COALESCE(a.aplicado,0)),0) AS disponible
        FROM movimientos_tesoreria mt
        JOIN ordenes_pago op ON op.id=mt.id_orden_pago AND op.clase_pago='PAGO_PROPIO' AND op.estado<>'ANULADA'
        LEFT JOIN (
          SELECT id_movimiento_tesoreria, SUM(importe) FILTER (WHERE estado='APLICADO') AS aplicado
          FROM pago_propio_asignaciones GROUP BY id_movimiento_tesoreria
        ) a ON a.id_movimiento_tesoreria=mt.id
      `)
    ]);
    res.json({ ...ordenes.rows[0], ...cheques.rows[0], pago_propio_disponible: propio.rows[0].disponible });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/ordenes-pago', async (req, res) => {
  try {
    const params = [];
    const where = [];
    if (req.query.clase_pago) {
      if (!CLASES_ORDEN.has(req.query.clase_pago)) return res.status(400).json({ error: 'Clase de pago invalida' });
      params.push(req.query.clase_pago);
      where.push(`op.clase_pago=$${params.length}`);
    }
    if (req.query.modalidad) {
      if (!MODALIDADES.has(req.query.modalidad)) return res.status(400).json({ error: 'Modalidad invalida' });
      params.push(req.query.modalidad);
      where.push(`op.modalidad_origen=$${params.length}`);
    }
    params.push(Math.max(1, Math.min(500, Number(req.query.limite) || 200)));
    const { rows } = await pool.query(`
      SELECT op.*, cp.razon_social AS contraparte, cp.cuit,
             COUNT(DISTINCT mt.id) AS instrumentos,
             COUNT(DISTINCT ch.id) AS cheques,
             COALESCE(SUM(CASE WHEN mt.id IS NOT NULL THEN mt.importe ELSE 0 END),0) AS importe_instrumentado
      FROM ordenes_pago op
      JOIN contrapartes cp ON cp.id=op.id_contraparte
      LEFT JOIN movimientos_tesoreria mt ON mt.id_orden_pago=op.id
      LEFT JOIN cheques_tesoreria ch ON ch.id_movimiento_tesoreria=mt.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY op.id, cp.razon_social, cp.cuit
      ORDER BY op.fecha DESC, op.id DESC
      LIMIT $${params.length}
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/ordenes-pago/:id', async (req, res) => {
  try {
    const { rows: ordenes } = await pool.query(`
      SELECT op.*, cp.razon_social AS contraparte, cp.cuit
      FROM ordenes_pago op JOIN contrapartes cp ON cp.id=op.id_contraparte
      WHERE op.id=$1
    `, [req.params.id]);
    if (!ordenes[0]) return res.status(404).json({ error: 'Orden de pago no encontrada' });
    const [instrumentos, aplicaciones, conceptos, trazabilidad, asignaciones] = await Promise.all([
      pool.query(`
        SELECT mt.*, cb.nombre AS cuenta_bancaria, cb.banco AS banco_cuenta,
               ch.id AS cheque_id, ch.tipo AS cheque_tipo, ch.numero AS cheque_numero,
               ch.banco AS cheque_banco, ch.librador, ch.cuit_librador,
               ch.fecha_emision AS cheque_fecha_emision, ch.fecha_pago AS cheque_fecha_pago,
               ch.estado AS cheque_estado, ch.cruzado,
               COALESCE((SELECT SUM(pa.importe) FROM pago_propio_asignaciones pa
                         WHERE pa.id_movimiento_tesoreria=mt.id AND pa.estado='APLICADO'),0) AS importe_asignado
        FROM movimientos_tesoreria mt
        LEFT JOIN cuentas_bancarias cb ON cb.id=mt.id_cuenta_bancaria
        LEFT JOIN cheques_tesoreria ch ON ch.id_movimiento_tesoreria=mt.id
        WHERE mt.id_orden_pago=$1 ORDER BY mt.id
      `, [req.params.id]),
      pool.query(`
        SELECT a.*, l.nro_liquidacion FROM aplicaciones_orden_pago a
        JOIN liquidaciones l ON l.id=a.id_liquidacion WHERE a.id_orden_pago=$1 ORDER BY a.id
      `, [req.params.id]),
      pool.query(`
        SELECT oc.*, c.codigo, c.nombre, c.categoria
        FROM orden_pago_conceptos_fiscales oc
        JOIN conceptos_fiscales_tesoreria c ON c.id=oc.id_concepto_fiscal
        WHERE oc.id_orden_pago=$1 ORDER BY oc.id
      `, [req.params.id]),
      pool.query(`
        SELECT t.*, co.razon_social AS contraparte_origen, cd.razon_social AS contraparte_destino
        FROM trazabilidad_instrumentos_pago t
        LEFT JOIN contrapartes co ON co.id=t.id_contraparte_origen
        LEFT JOIN contrapartes cd ON cd.id=t.id_contraparte_destino
        WHERE t.id_orden_pago=$1 ORDER BY t.fecha, t.id
      `, [req.params.id]),
      pool.query(`
        SELECT pa.*, cp.razon_social AS contraparte_destino
        FROM pago_propio_asignaciones pa JOIN contrapartes cp ON cp.id=pa.id_contraparte_destino
        WHERE pa.id_orden_pago=$1 ORDER BY pa.id
      `, [req.params.id])
    ]);
    res.json({
      ...ordenes[0],
      instrumentos: instrumentos.rows,
      aplicaciones: aplicaciones.rows,
      conceptos_fiscales: conceptos.rows,
      trazabilidad: trazabilidad.rows,
      asignaciones_pago_propio: asignaciones.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ordenes-pago', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      clase_pago, modalidad_origen = 'FORMAL', id_contraparte, fecha, fecha_pago,
      concepto, importe_bruto, moneda = 'PESOS', instrumentos = [], aplicaciones = [],
      conceptos_fiscales = [], entregado_por, recibido_por
    } = req.body;
    if (!CLASES_ORDEN.has(clase_pago) || !MODALIDADES.has(modalidad_origen) || !id_contraparte || !fecha || !concepto) {
      return res.status(400).json({ error: 'Clase, modalidad, contraparte, fecha y concepto son obligatorios' });
    }
    if (clase_pago === 'PAGO_PROPIO' && modalidad_origen !== 'FORMAL') {
      return res.status(400).json({ error: 'Pago Propio debe originarse en el circuito FORMAL' });
    }
    const bruto = numero(importe_bruto);
    if (bruto <= 0) return res.status(400).json({ error: 'El importe bruto debe ser positivo' });
    if (!Array.isArray(instrumentos) || !instrumentos.length) {
      return res.status(400).json({ error: 'La orden requiere al menos un instrumento de pago' });
    }
    for (const instrumento of instrumentos) {
      if (!MEDIOS_ORDEN.has(instrumento.medio_pago) || numero(instrumento.importe) <= 0) {
        return res.status(400).json({ error: 'Todos los instrumentos deben tener medio e importe validos' });
      }
      if (instrumento.medio_pago === 'TRANSFERENCIA' && !instrumento.id_cuenta_bancaria) {
        return res.status(400).json({ error: 'Cada transferencia requiere una cuenta bancaria' });
      }
      if (instrumento.medio_pago === 'CHEQUE_PROPIO' && !instrumento.id_cuenta_bancaria) {
        return res.status(400).json({ error: 'Cada cheque propio requiere la cuenta bancaria libradora' });
      }
      if (chequeMedio(instrumento.medio_pago)) {
        const ch = instrumento.cheque || {};
        if (!ch.numero || !ch.banco || !ch.fecha_pago) {
          return res.status(400).json({ error: 'Cada cheque requiere numero, banco y fecha de pago' });
        }
        if (ch.cuit_librador && String(ch.cuit_librador).replace(/\D/g, '').length !== 11) {
          return res.status(400).json({ error: 'El CUIT del librador debe tener 11 digitos' });
        }
      }
    }
    if (clase_pago === 'PAGO_PROPIO' && instrumentos.some(item => chequeMedio(item.medio_pago)) && (!entregado_por || !recibido_por)) {
      return res.status(400).json({ error: 'Pago Propio con cheque requiere indicar quién entrega y quién recibe' });
    }

    await client.query('BEGIN');
    const conceptosNormalizados = [];
    let totalAdiciones = 0;
    let totalRetenciones = 0;
    for (const item of conceptos_fiscales) {
      const { rows } = await client.query(`
        SELECT id, naturaleza FROM conceptos_fiscales_tesoreria WHERE id=$1 AND activo=TRUE
      `, [item.id_concepto_fiscal]);
      if (!rows[0]) throw Object.assign(new Error('Concepto fiscal no encontrado o inactivo'), { status: 400 });
      const importe = numero(item.importe);
      if (importe < 0) throw Object.assign(new Error('El importe fiscal no puede ser negativo'), { status: 400 });
      const naturaleza = rows[0].naturaleza;
      if (naturaleza === 'ADICION') totalAdiciones += importe;
      if (naturaleza === 'RETENCION') totalRetenciones += importe;
      conceptosNormalizados.push({ ...item, importe, naturaleza });
    }
    const neto = Math.round((bruto + totalAdiciones - totalRetenciones) * 10000) / 10000;
    if (neto <= 0) throw Object.assign(new Error('Las retenciones no pueden dejar una orden sin importe neto'), { status: 400 });
    const totalInstrumentos = instrumentos.reduce((s, item) => s + numero(item.importe), 0);
    if (Math.abs(totalInstrumentos - neto) > 0.0001) {
      throw Object.assign(new Error(`Los instrumentos deben sumar el neto de la orden (${neto.toFixed(2)})`), { status: 400 });
    }
    const totalAplicado = aplicaciones.reduce((s, item) => s + numero(item.importe), 0);
    if (totalAplicado > neto + 0.0001 || aplicaciones.some(item => !item.id_liquidacion || numero(item.importe) <= 0)) {
      throw Object.assign(new Error('Las aplicaciones deben ser positivas y no superar el neto pagado'), { status: 400 });
    }

    const { rows: contraparteRows } = await client.query('SELECT id FROM contrapartes WHERE id=$1 AND activo=TRUE', [id_contraparte]);
    if (!contraparteRows[0]) throw Object.assign(new Error('Contraparte no encontrada'), { status: 404 });
    for (const instrumento of instrumentos) {
      if (!instrumento.id_cuenta_bancaria) continue;
      const { rows } = await client.query('SELECT id FROM cuentas_bancarias WHERE id=$1 AND activa=TRUE', [instrumento.id_cuenta_bancaria]);
      if (!rows[0]) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 404 });
    }
    for (const aplicacion of aplicaciones) {
      const { rows } = await client.query(`
        SELECT l.id, l.monto_neto_a_pagar,
               COALESCE((SELECT SUM(a.importe) FROM aplicaciones_tesoreria a WHERE a.id_liquidacion=l.id),0) +
               COALESCE((SELECT SUM(a.importe) FROM aplicaciones_orden_pago a WHERE a.id_liquidacion=l.id),0) AS aplicado
        FROM liquidaciones l
        WHERE l.id=$1 AND l.id_contraparte=$2 AND l.modalidad=$3
        FOR UPDATE OF l
      `, [aplicacion.id_liquidacion, id_contraparte, modalidad_origen]);
      if (!rows[0]) throw Object.assign(new Error('La liquidacion no pertenece a la contraparte y modalidad de la orden'), { status: 400 });
      if (numero(aplicacion.importe) > numero(rows[0].monto_neto_a_pagar) - numero(rows[0].aplicado) + 0.0001) {
        throw Object.assign(new Error('La aplicacion supera el saldo pendiente de la liquidacion'), { status: 400 });
      }
    }

    const { rows: ordenRows } = await client.query(`
      INSERT INTO ordenes_pago
        (clase_pago,modalidad_origen,modalidad_destino,id_contraparte,fecha,fecha_pago,
         concepto,importe_bruto,total_adiciones,total_retenciones,importe_total,moneda,estado,creado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PAGADA',$13)
      RETURNING *
    `, [clase_pago, modalidad_origen, clase_pago === 'PAGO_PROPIO' ? 'INFORMAL' : modalidad_origen,
      id_contraparte, fecha, fecha_pago || fecha, concepto, bruto, totalAdiciones,
      totalRetenciones, neto, moneda, req.user?.id || null]);
    const orden = ordenRows[0];
    const prefijo = clase_pago === 'PAGO_PROPIO' ? 'PP' : 'OP';
    const numeroOrden = `${prefijo}-${String(fecha).slice(0,4)}-${String(orden.id).padStart(6, '0')}`;
    await client.query('UPDATE ordenes_pago SET numero=$1 WHERE id=$2', [numeroOrden, orden.id]);

    const { rows: ccRows } = await client.query(`
      INSERT INTO cc_contrapartes
        (id_contraparte,id_orden_pago,fecha,tipo_movimiento,concepto,debe,haber,
         saldo_acumulado,modalidad,estado)
      VALUES ($1,$2,$3,$4,$5,$6,0,$6,$7,'ABIERTO') RETURNING id
    `, [id_contraparte, orden.id, fecha, clase_pago, `${numeroOrden} - ${concepto}`, neto, modalidad_origen]);
    await client.query('UPDATE ordenes_pago SET id_cc_movimiento=$1 WHERE id=$2', [ccRows[0].id, orden.id]);

    for (const aplicacion of aplicaciones) {
      await client.query(`
        INSERT INTO aplicaciones_orden_pago (id_orden_pago,id_liquidacion,importe)
        VALUES ($1,$2,$3)
      `, [orden.id, aplicacion.id_liquidacion, numero(aplicacion.importe)]);
    }
    for (const fiscal of conceptosNormalizados) {
      await client.query(`
        INSERT INTO orden_pago_conceptos_fiscales
          (id_orden_pago,id_concepto_fiscal,base_imponible,alicuota,importe,naturaleza)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [orden.id, fiscal.id_concepto_fiscal, fiscal.base_imponible == null ? null : numero(fiscal.base_imponible),
        fiscal.alicuota == null ? null : numero(fiscal.alicuota), fiscal.importe, fiscal.naturaleza]);
    }

    const instrumentosCreados = [];
    for (const instrumento of instrumentos) {
      const medio = medioPersistido(instrumento.medio_pago);
      const { rows: movRows } = await client.query(`
        INSERT INTO movimientos_tesoreria
          (id_orden_pago,id_contraparte,id_cuenta_bancaria,fecha,fecha_valor,tipo,
           medio_pago,importe,moneda,cotizacion,referencia,metadata,creado_por,
           modalidad,clase_pago)
        VALUES ($1,$2,$3,$4,$5,'PAGO',$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
        RETURNING *
      `, [orden.id, id_contraparte, instrumento.id_cuenta_bancaria || null, fecha,
        instrumento.fecha_valor || fecha_pago || fecha, medio, numero(instrumento.importe), moneda,
        instrumento.cotizacion || null, instrumento.referencia || numeroOrden,
        JSON.stringify(instrumento.metadata || {}), req.user?.id || null, modalidad_origen, clase_pago]);
      const movimiento = movRows[0];
      let chequeId = null;
      if (chequeMedio(instrumento.medio_pago)) {
        const ch = instrumento.cheque;
        const tipo = tipoCheque(instrumento);
        if (!['PROPIO','TERCERO','ECHEQ'].includes(tipo)) {
          throw Object.assign(new Error('Tipo de cheque invalido'), { status: 400 });
        }
        const { rows: chequeRows } = await client.query(`
          INSERT INTO cheques_tesoreria
            (id_movimiento_tesoreria,tipo,numero,banco,librador,cuit_librador,
             fecha_emision,fecha_pago,importe,moneda,estado,observaciones,cruzado)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE)
          RETURNING *
        `, [movimiento.id, tipo, ch.numero, ch.banco, ch.librador || null,
          ch.cuit_librador ? String(ch.cuit_librador).replace(/\D/g, '') : null,
          ch.fecha_emision || fecha, ch.fecha_pago, numero(instrumento.importe), moneda,
          clase_pago === 'PAGO_PROPIO' ? 'TRANSFERIDO' : 'ENTREGADO',
          ch.observaciones || null]);
        chequeId = chequeRows[0].id;
      }
      await client.query(`
        INSERT INTO trazabilidad_instrumentos_pago
          (id_orden_pago,id_movimiento_tesoreria,id_cheque,evento,modalidad_origen,
           modalidad_destino,id_contraparte_destino,entregado_por,recibido_por,
           observaciones,creado_por)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [orden.id, movimiento.id, chequeId,
        clase_pago === 'PAGO_PROPIO' ? 'TRANSFERIDO_A_PAGO_PROPIO' : 'PAGO_A_PROVEEDOR',
        modalidad_origen, clase_pago === 'PAGO_PROPIO' ? 'INFORMAL' : modalidad_origen,
        id_contraparte, entregado_por || null, recibido_por || null,
        instrumento.observaciones || null, req.user?.id || null]);
      instrumentosCreados.push({ ...movimiento, cheque_id: chequeId });
    }
    await client.query('COMMIT');
    const respuesta = { ...orden, numero: numeroOrden, id_cc_movimiento: ccRows[0].id, instrumentos: instrumentosCreados };
    await registrarAuditoria(req, { accion: 'CREAR', modulo: 'tesoreria_ordenes_pago', registro_id: orden.id, datos_despues: respuesta });
    res.status(201).json(respuesta);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'El instrumento o cheque ya fue registrado' });
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.get('/pago-propio/cartera', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT op.id AS id_orden_pago, op.numero AS orden_numero, op.fecha, op.concepto,
             cp.razon_social AS receptor_pago_propio,
             mt.id AS id_movimiento_tesoreria, mt.medio_pago, mt.importe, mt.moneda,
             COALESCE(SUM(pa.importe) FILTER (WHERE pa.estado='APLICADO'),0) AS importe_asignado,
             mt.importe-COALESCE(SUM(pa.importe) FILTER (WHERE pa.estado='APLICADO'),0) AS disponible,
             ch.id AS cheque_id, ch.tipo AS cheque_tipo, ch.numero AS cheque_numero,
             ch.banco AS cheque_banco, ch.librador, ch.fecha_emision, ch.fecha_pago,
             ch.estado AS cheque_estado, ch.cruzado
      FROM ordenes_pago op
      JOIN contrapartes cp ON cp.id=op.id_contraparte
      JOIN movimientos_tesoreria mt ON mt.id_orden_pago=op.id
      LEFT JOIN cheques_tesoreria ch ON ch.id_movimiento_tesoreria=mt.id
      LEFT JOIN pago_propio_asignaciones pa ON pa.id_movimiento_tesoreria=mt.id
      WHERE op.clase_pago='PAGO_PROPIO' AND op.estado<>'ANULADA'
      GROUP BY op.id, cp.razon_social, mt.id, ch.id
      HAVING mt.importe-COALESCE(SUM(pa.importe) FILTER (WHERE pa.estado='APLICADO'),0) > 0
      ORDER BY ch.fecha_pago NULLS LAST, op.fecha, mt.id
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/pago-propio/:id/asignaciones', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id_movimiento_tesoreria, id_contraparte_destino, fecha, importe, concepto, entregado_por, recibido_por } = req.body;
    const valor = numero(importe);
    if (!id_movimiento_tesoreria || !id_contraparte_destino || !fecha || valor <= 0 || !concepto) {
      return res.status(400).json({ error: 'Instrumento, proveedor, fecha, importe y concepto son obligatorios' });
    }
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT op.id, op.numero, op.clase_pago, op.estado, mt.importe AS importe_instrumento,
             mt.modalidad, ch.id AS cheque_id, ch.tipo AS cheque_tipo,
             COALESCE((SELECT SUM(pa.importe) FROM pago_propio_asignaciones pa
                       WHERE pa.id_movimiento_tesoreria=mt.id AND pa.estado='APLICADO'),0) AS asignado
      FROM ordenes_pago op
      JOIN movimientos_tesoreria mt ON mt.id_orden_pago=op.id
      LEFT JOIN cheques_tesoreria ch ON ch.id_movimiento_tesoreria=mt.id
      WHERE op.id=$1 AND mt.id=$2
      FOR UPDATE OF op, mt
    `, [req.params.id, id_movimiento_tesoreria]);
    const item = rows[0];
    if (!item || item.clase_pago !== 'PAGO_PROPIO' || item.estado === 'ANULADA') {
      throw Object.assign(new Error('Instrumento de Pago Propio no encontrado'), { status: 404 });
    }
    const disponible = numero(item.importe_instrumento) - numero(item.asignado);
    if (valor > disponible + 0.0001) {
      throw Object.assign(new Error('La imputacion supera el disponible del instrumento'), { status: 400 });
    }
    if (item.cheque_id) {
      if (!entregado_por || !recibido_por) {
        throw Object.assign(new Error('Para entregar un cheque debe indicarse quien entrega y quien recibe'), { status: 400 });
      }
      if (numero(item.asignado) > 0 || Math.abs(valor - numero(item.importe_instrumento)) > 0.0001) {
        throw Object.assign(new Error('Un cheque fisico se entrega completo a un solo proveedor; no puede dividirse'), { status: 400 });
      }
    }
    const { rows: cpRows } = await client.query('SELECT id FROM contrapartes WHERE id=$1 AND activo=TRUE', [id_contraparte_destino]);
    if (!cpRows[0]) throw Object.assign(new Error('Proveedor destino no encontrado'), { status: 404 });
    const { rows: ccRows } = await client.query(`
      INSERT INTO cc_contrapartes
        (id_contraparte,fecha,tipo_movimiento,concepto,debe,haber,saldo_acumulado,modalidad,estado)
      VALUES ($1,$2,'PAGO_PROPIO_APLICADO',$3,$4,0,$4,'INFORMAL','ABIERTO') RETURNING id
    `, [id_contraparte_destino, fecha, `${item.numero} - ${concepto}`, valor]);
    const { rows: asignacionRows } = await client.query(`
      INSERT INTO pago_propio_asignaciones
        (id_orden_pago,id_movimiento_tesoreria,id_contraparte_destino,id_cc_movimiento,
         fecha,importe,concepto,entregado_por,recibido_por,creado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [item.id, id_movimiento_tesoreria, id_contraparte_destino, ccRows[0].id,
      fecha, valor, concepto, entregado_por || null, recibido_por || null, req.user?.id || null]);
    if (item.cheque_id) {
      await client.query("UPDATE cheques_tesoreria SET estado='ENTREGADO', updated_at=NOW() WHERE id=$1", [item.cheque_id]);
    }
    await client.query(`
      INSERT INTO trazabilidad_instrumentos_pago
        (id_orden_pago,id_movimiento_tesoreria,id_cheque,evento,modalidad_origen,
         modalidad_destino,id_contraparte_destino,entregado_por,recibido_por,
         observaciones,creado_por)
      VALUES ($1,$2,$3,'ASIGNADO_A_PROVEEDOR','FORMAL','INFORMAL',$4,$5,$6,$7,$8)
    `, [item.id, id_movimiento_tesoreria, item.cheque_id || null, id_contraparte_destino,
      entregado_por || null, recibido_por || null, concepto, req.user?.id || null]);
    await client.query('COMMIT');
    await registrarAuditoria(req, { accion: 'IMPUTAR', modulo: 'tesoreria_pago_propio', registro_id: asignacionRows[0].id, datos_despues: asignacionRows[0] });
    res.status(201).json({ ...asignacionRows[0], id_cc_movimiento: ccRows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
