jest.mock('pg');

const request = require('supertest');
const { buildTestApp } = require('./helpers/testApp');

describe('Tesorería', () => {
  let app;
  let contraparteId;
  let proveedorDestinoId;
  let liquidacionId;
  let cuentaId;
  let movimientoId;

  beforeAll(async () => {
    app = await buildTestApp();
    const { pool } = require('../src/db');
    const suffix = Date.now();
    const { rows } = await pool.query(`
      INSERT INTO contrapartes (codigo_interno,razon_social,tipo_contraparte,canal_operacion)
      VALUES ($1,'Contraparte Tesorería','COMPRADOR','FORMAL') RETURNING id
    `, [`TES-${suffix}`]);
    contraparteId = rows[0].id;
    const proveedorDestino = await pool.query(`
      INSERT INTO contrapartes (codigo_interno,razon_social,tipo_contraparte,canal_operacion)
      VALUES ($1,'Proveedor Informal Tesoreria','PRODUCTOR','INFORMAL') RETURNING id
    `, [`TDS-${suffix}`]);
    proveedorDestinoId = proveedorDestino.rows[0].id;
    const liquidacion = await pool.query(`
      INSERT INTO liquidaciones
        (nro_liquidacion,tipo,modalidad,id_contraparte,fecha_liquidacion,monto_neto_a_pagar,moneda,estado)
      VALUES ($1,'VENTA','FORMAL',$2,'2026-08-10',1000,'PESOS','EMITIDA') RETURNING id
    `, [`TES-LIQ-${suffix}`, contraparteId]);
    liquidacionId = liquidacion.rows[0].id;
    const movimiento = await pool.query(`
      INSERT INTO movimientos
        (numero_movimiento,modalidad,estado,nro_cpe,nro_ctg,fecha_cpe,
         remitente_comercial_productor_nombre,destinatario_nombre)
      VALUES ($1,'FORMAL','DESCARGADO','CPE-TES-001',$2,'2026-08-10',
              'Contraparte Tesoreria','Destino Tesoreria') RETURNING id
    `, [`MOV-TES-${suffix}`, `101${String(suffix).slice(-8)}`]);
    movimientoId = movimiento.rows[0].id;
    await pool.query(`
      INSERT INTO liquidacion_movimientos
        (id_liquidacion,id_movimiento,kg_liquidables,factor_aplicado,precio_aplicado,monto_bruto_parcial)
      VALUES ($1,$2,30000,1,10,300)
    `, [liquidacionId, movimientoId]);
  });

  test('registra una transferencia estructurada y su asiento de cuenta corriente', async () => {
    const cuenta = await request(app).post('/api/tesoreria/cuentas-bancarias').send({
      nombre: 'Cuenta operativa', banco: 'Banco de prueba', cbu: '1234567890123456789012'
    });
    expect(cuenta.status).toBe(201);
    expect(cuenta.body.conexion_estado).toBe('NO_CONFIGURADA');
    cuentaId = cuenta.body.id;

    const movimiento = await request(app).post('/api/tesoreria/movimientos').send({
      id_contraparte: contraparteId,
      id_cuenta_bancaria: cuenta.body.id,
      fecha: '2026-08-11',
      tipo: 'COBRO',
      medio_pago: 'TRANSFERENCIA',
      importe: 150000,
      referencia: 'TRX-PRUEBA'
    });
    expect(movimiento.status).toBe(201);
    expect(movimiento.body.id_cc_movimiento).toBeTruthy();

    const extracto = await request(app).get(`/api/cc/contrapartes/${contraparteId}`);
    expect(extracto.body).toHaveLength(1);
    expect(Number(extracto.body[0].haber)).toBe(150000);
  });

  test('exige una cuenta bancaria para transferencias', async () => {
    const response = await request(app).post('/api/tesoreria/movimientos').send({
      id_contraparte: contraparteId,
      fecha: '2026-08-11',
      tipo: 'PAGO',
      medio_pago: 'TRANSFERENCIA',
      importe: 100
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/cuenta bancaria/i);
  });

  test('registra un cheque y permite seguir su estado', async () => {
    const movimiento = await request(app).post('/api/tesoreria/movimientos').send({
      id_contraparte: contraparteId,
      fecha: '2026-08-12',
      tipo: 'COBRO',
      medio_pago: 'CHEQUE_TERCEROS',
      importe: 600,
      aplicaciones: [{ id_liquidacion: liquidacionId, importe: 600 }],
      cheque: {
        tipo: 'ECHEQ', numero: 'ECQ-100', banco: 'Banco de prueba',
        fecha_pago: '2026-09-10', librador: 'Cliente de prueba'
      }
    });
    expect(movimiento.status).toBe(201);
    expect(Number(movimiento.body.importe_aplicado)).toBe(600);

    const cartera = await request(app).get('/api/tesoreria/cheques?estado=EN_CARTERA');
    expect(cartera.status).toBe(200);
    expect(cartera.body).toHaveLength(1);

    const depositado = await request(app)
      .patch(`/api/tesoreria/cheques/${cartera.body[0].id}/estado`)
      .send({ estado: 'DEPOSITADO' });
    expect(depositado.status).toBe(200);
    expect(depositado.body.estado).toBe('DEPOSITADO');
  });

  test('impide aplicar más que el saldo pendiente', async () => {
    const response = await request(app).post('/api/tesoreria/movimientos').send({
      id_contraparte: contraparteId,
      fecha: '2026-08-13', tipo: 'COBRO', medio_pago: 'EFECTIVO', importe: 500,
      aplicaciones: [{ id_liquidacion: liquidacionId, importe: 500 }]
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/saldo pendiente/i);
  });

  test('la cuenta corriente no admite pagos manuales', async () => {
    const response = await request(app).post('/api/cc/movimientos').send({
      id_contraparte: contraparteId,
      fecha: '2026-08-14',
      tipo_movimiento: 'PAGO',
      debe: 100
    });
    expect(response.status).toBe(405);
    expect(response.body.error).toMatch(/solo consulta/i);
  });

  test('el detalle del movimiento incluye liquidacion y bloque documental exportable', async () => {
    const response = await request(app).get(`/api/movimientos/${movimientoId}`);
    expect(response.status).toBe(200);
    expect(response.body.liquidaciones).toHaveLength(1);
    expect(response.body.liquidaciones[0].nro_liquidacion).toMatch(/^TES-LIQ-/);
    expect(response.body.documentos).toHaveProperty('cpe');
    expect(response.body.documentos.certificados).toEqual(expect.any(Array));
  });

  test('crea una orden de pago con retencion y deja el medio visible en cuenta corriente', async () => {
    const conceptos = await request(app).get('/api/tesoreria/conceptos-fiscales');
    expect(conceptos.status).toBe(200);
    const retencionIva = conceptos.body.find(item => item.codigo === 'RET_IVA');
    expect(retencionIva).toBeTruthy();

    const orden = await request(app).post('/api/tesoreria/ordenes-pago').send({
      clase_pago: 'PAGO_PROVEEDOR',
      modalidad_origen: 'FORMAL',
      id_contraparte: contraparteId,
      fecha: '2026-08-15',
      concepto: 'Pago liquidacion de prueba',
      importe_bruto: 350,
      conceptos_fiscales: [{
        id_concepto_fiscal: retencionIva.id,
        base_imponible: 350,
        alicuota: 14.2857,
        importe: 50
      }],
      aplicaciones: [{ id_liquidacion: liquidacionId, importe: 300 }],
      instrumentos: [{
        medio_pago: 'TRANSFERENCIA',
        id_cuenta_bancaria: cuentaId,
        importe: 300,
        referencia: 'TRX-ORDEN-001'
      }]
    });
    expect(orden.status).toBe(201);
    expect(orden.body.numero).toMatch(/^OP-2026-/);
    expect(Number(orden.body.importe_total)).toBe(300);

    const detalle = await request(app).get(`/api/tesoreria/ordenes-pago/${orden.body.id}`);
    expect(detalle.status).toBe(200);
    expect(detalle.body.instrumentos).toHaveLength(1);
    expect(detalle.body.instrumentos[0].medio_pago).toBe('TRANSFERENCIA');
    expect(detalle.body.conceptos_fiscales).toHaveLength(1);

    const cuentaCorriente = await request(app).get(`/api/cc/contrapartes/${contraparteId}`);
    const asiento = cuentaCorriente.body.find(item => item.numero_orden_pago === orden.body.numero);
    expect(asiento).toBeTruthy();
    expect(asiento.instrumentos_pago[0].medio_pago).toBe('TRANSFERENCIA');
  });

  test('Pago Propio conserva el cheque cruzado y solo permite entregarlo completo a un proveedor', async () => {
    const orden = await request(app).post('/api/tesoreria/ordenes-pago').send({
      clase_pago: 'PAGO_PROPIO',
      modalidad_origen: 'FORMAL',
      id_contraparte: contraparteId,
      fecha: '2026-08-16',
      concepto: 'Fondos para circuito informal',
      importe_bruto: 700,
      entregado_por: 'Administracion Formal',
      recibido_por: 'Tesoreria Informal',
      instrumentos: [{
        medio_pago: 'CHEQUE_TERCEROS',
        importe: 700,
        cheque: {
          numero: `PP-${Date.now()}`,
          banco: 'Banco de prueba',
          librador: 'Cliente de prueba',
          fecha_pago: '2026-09-20'
        }
      }]
    });
    expect(orden.status).toBe(201);
    expect(orden.body.numero).toMatch(/^PP-2026-/);

    const cartera = await request(app).get('/api/tesoreria/pago-propio/cartera');
    expect(cartera.status).toBe(200);
    const instrumento = cartera.body.find(item => item.id_orden_pago === orden.body.id);
    expect(instrumento).toBeTruthy();
    expect(instrumento.cruzado).toBe(true);
    expect(Number(instrumento.disponible)).toBe(700);

    const parcial = await request(app)
      .post(`/api/tesoreria/pago-propio/${orden.body.id}/asignaciones`)
      .send({
        id_movimiento_tesoreria: instrumento.id_movimiento_tesoreria,
        id_contraparte_destino: proveedorDestinoId,
        fecha: '2026-08-17',
        importe: 300,
        concepto: 'Pago parcial no permitido',
        entregado_por: 'Tesoreria Informal',
        recibido_por: 'Proveedor Informal'
      });
    expect(parcial.status).toBe(400);
    expect(parcial.body.error).toMatch(/completo.*un solo proveedor/i);

    const total = await request(app)
      .post(`/api/tesoreria/pago-propio/${orden.body.id}/asignaciones`)
      .send({
        id_movimiento_tesoreria: instrumento.id_movimiento_tesoreria,
        id_contraparte_destino: proveedorDestinoId,
        fecha: '2026-08-17',
        importe: 700,
        concepto: 'Pago final a proveedor informal',
        entregado_por: 'Tesoreria Informal',
        recibido_por: 'Proveedor Informal'
      });
    expect(total.status).toBe(201);

    const detalle = await request(app).get(`/api/tesoreria/ordenes-pago/${orden.body.id}`);
    expect(detalle.body.instrumentos[0].cheque_estado).toBe('ENTREGADO');
    expect(detalle.body.asignaciones_pago_propio).toHaveLength(1);
    expect(detalle.body.trazabilidad.map(item => item.evento)).toEqual(
      expect.arrayContaining(['TRANSFERIDO_A_PAGO_PROPIO', 'ASIGNADO_A_PROVEEDOR'])
    );

    const cuentaDestino = await request(app).get(`/api/cc/contrapartes/${proveedorDestinoId}?modalidad=INFORMAL`);
    expect(cuentaDestino.body).toHaveLength(1);
    expect(cuentaDestino.body[0].tipo_movimiento).toBe('PAGO_PROPIO_APLICADO');
  });
});
