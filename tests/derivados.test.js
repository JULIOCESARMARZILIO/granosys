jest.mock('pg');

const request = require('supertest');
const { buildTestApp } = require('./helpers/testApp');

describe('Derivados granarios', () => {
  let app;
  let producto;

  beforeAll(async () => {
    app = await buildTestApp();
    const especies = await request(app).get('/api/especies');
    producto = especies.body.find(item => item.tipo_producto === 'SUBPRODUCTO');
    expect(producto).toBeDefined();
  });

  test('crea un informal y su espejo formal sin duplicar impacto de stock', async () => {
    const creada = await request(app).post('/api/derivados').send({
      modalidad: 'INFORMAL',
      tipo_operacion: 'COMPRA',
      fecha: '2026-08-18',
      id_especie: producto.id,
      kilos: 30000
    });
    expect(creada.status).toBe(201);
    expect(creada.body.impacta_stock).toBe(true);

    const espejo = await request(app)
      .post(`/api/derivados/${creada.body.id}/crear-espejo-formal`)
      .send({});
    expect(espejo.status).toBe(201);
    expect(espejo.body.modalidad).toBe('FORMAL');
    expect(espejo.body.impacta_stock).toBe(false);

    const informal = await request(app).get('/api/derivados?modalidad=INFORMAL');
    const formal = await request(app).get('/api/derivados?modalidad=FORMAL');
    expect(informal.body[0].espejo_numero).toBe(espejo.body.numero_operacion);
    expect(formal.body[0].espejo_numero).toBe(creada.body.numero_operacion);
    expect([...informal.body, ...formal.body].filter(item => item.impacta_stock)).toHaveLength(1);
  });

  test('rechaza duplicar un CTG dentro de la misma modalidad', async () => {
    const payload = {
      modalidad: 'FORMAL', tipo_operacion: 'VENTA', fecha: '2026-08-18',
      id_especie: producto.id, kilos: 1000, ctg: '10199999999'
    };
    expect((await request(app).post('/api/derivados').send(payload)).status).toBe(201);
    expect((await request(app).post('/api/derivados').send(payload)).status).toBe(409);
  });
});
