jest.mock('pg');

const request = require('supertest');
const { buildTestApp } = require('./helpers/testApp');

describe('Tesorería', () => {
  let app;
  let contraparteId;
  let liquidacionId;

  beforeAll(async () => {
    app = await buildTestApp();
    const { pool } = require('../src/db');
    const suffix = Date.now();
    const { rows } = await pool.query(`
      INSERT INTO contrapartes (codigo_interno,razon_social,tipo_contraparte,canal_operacion)
      VALUES ($1,'Contraparte Tesorería','COMPRADOR','FORMAL') RETURNING id
    `, [`TES-${suffix}`]);
    contraparteId = rows[0].id;
    const liquidacion = await pool.query(`
      INSERT INTO liquidaciones
        (nro_liquidacion,tipo,modalidad,id_contraparte,fecha_liquidacion,monto_neto_a_pagar,moneda,estado)
      VALUES ($1,'VENTA','FORMAL',$2,'2026-08-10',1000,'PESOS','EMITIDA') RETURNING id
    `, [`TES-LIQ-${suffix}`, contraparteId]);
    liquidacionId = liquidacion.rows[0].id;
  });

  test('registra una transferencia estructurada y su asiento de cuenta corriente', async () => {
    const cuenta = await request(app).post('/api/tesoreria/cuentas-bancarias').send({
      nombre: 'Cuenta operativa', banco: 'Banco de prueba', cbu: '1234567890123456789012'
    });
    expect(cuenta.status).toBe(201);
    expect(cuenta.body.conexion_estado).toBe('NO_CONFIGURADA');

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
});
