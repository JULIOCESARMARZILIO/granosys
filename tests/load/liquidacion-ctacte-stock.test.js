// Investigación (100% local, PGlite en memoria -- ver __mocks__/pg.js):
// al liquidar un contrato, ¿impacta el saldo de cuenta corriente? ¿se
// actualiza el stock? Se arma el circuito completo real: contrato -> alta de
// movimiento -> registro de llegada (calcula kg_liquidables) -> liquidación,
// y se inspeccionan las tablas cc_contrapartes y stock después de cada paso.
jest.mock('pg');

const { buildTestApp } = require('../helpers/testApp');
const request = require('supertest');

describe('Liquidación: impacto en cuenta corriente y stock', () => {
  let app;
  let especieId;
  let campanaId;
  let contraparteId;
  let contratoId;

  beforeAll(async () => {
    app = await buildTestApp();

    const especies = (await request(app).get('/api/especies')).body;
    especieId = especies.find(e => e.codigo === 'SOJ').id;

    const campanas = (await request(app).get('/api/campanas')).body;
    campanaId = (campanas.find(c => c.activa) || campanas[0]).id;

    const contraparte = await request(app).post('/api/contrapartes').send({
      cuit: '30-71020619-4',
      razon_social: 'Productor de Prueba S.A.',
      tipo_contraparte: 'PRODUCTOR',
      canal_operacion: 'FORMAL',
      condicion_iva: 'RI',
    });
    contraparteId = contraparte.body.id;

    const contrato = await request(app).post('/api/contratos').send({
      tipo_contrato: 'COMPRA',
      modalidad: 'FORMAL',
      tipo_liquidacion: 'CONTADO',
      fecha_contrato: '2026-03-01',
      id_contraparte: contraparteId,
      id_especie: especieId,
      id_campana: campanaId,
      cantidad_toneladas_pactadas: 100,
      tipo_precio: 'FIJO',
      moneda: 'PESOS',
      precio_pactado: 250,
      tipo_entrega: 'PUESTO_DESTINO',
      localidad_entrega: 'Rosario',
      provincia_entrega: 'Santa Fe',
      forma_pago: 'CONTADO',
      condicion_pago: 'CONTADO',
    });
    contratoId = contrato.body.id;
  });

  async function crearMovimientoConLlegada(pesoBrutoSalida) {
    const alta = await request(app).post('/api/movimientos').send({
      modalidad: 'FORMAL',
      id_contrato_compra: contratoId,
      id_especie: especieId,
      id_campana: campanaId,
      peso_bruto_salida_kg: pesoBrutoSalida,
      peso_tara_salida_kg: 15000,
      humedad_salida_pct: 13.5,
      usuario_carga: 'TEST_LOAD',
    });
    expect(alta.status).toBe(201);
    const mov = alta.body;

    const llegada = await request(app).put(`/api/movimientos/${mov.id}/llegada`).send({
      fecha_arribo: '2026-03-05T10:00:00Z',
      fecha_descarga: '2026-03-05T12:00:00Z',
      nro_turno: '1',
      peso_bruto_llegada_kg: pesoBrutoSalida,
      peso_tara_llegada_kg: 15000,
      humedad_llegada_pct: 13.5,
    });
    expect(llegada.status).toBe(200);
    expect(parseFloat(llegada.body.kg_liquidables)).toBeGreaterThan(0);
    return llegada.body;
  }

  test('el stock NO se actualiza en ningún paso del circuito (tabla muerta)', async () => {
    const antes = await request(app).get('/api/stock');
    expect(antes.status).toBe(200);
    expect(antes.body).toEqual([]); // nada la puebla nunca: ni alta, ni llegada, ni liquidación

    await crearMovimientoConLlegada(30000);

    const despues = await request(app).get('/api/stock');
    expect(despues.body).toEqual([]);
  });

  test('la liquidación SÍ impacta cc_contrapartes, y el saldo por-fila NO es acumulativo real', async () => {
    const mov1 = await crearMovimientoConLlegada(30000);
    const mov2 = await crearMovimientoConLlegada(30000);

    const ccAntes = await request(app).get(`/api/cc/contrapartes/${contraparteId}`);
    expect(ccAntes.body).toEqual([]);

    // Liquidación 1: cubre mov1 + mov2
    const liq1 = await request(app).post('/api/liquidaciones').send({
      tipo: 'COMPRA',
      modalidad: 'FORMAL',
      tipo_liquidacion: 'CONTADO',
      id_contrato: contratoId,
      id_contraparte: contraparteId,
      fecha_liquidacion: '2026-03-06',
      ids_movimientos: [mov1.id, mov2.id],
      moneda: 'PESOS',
    });
    expect(liq1.status).toBe(201);
    expect(parseFloat(liq1.body.monto_neto_a_pagar)).toBeGreaterThan(0);

    // Los movimientos quedan marcados como LIQUIDADO
    const mov1Post = (await request(app).get(`/api/movimientos/${mov1.id}`)).body;
    expect(mov1Post.estado_liquidacion).toBe('LIQUIDADO');

    const ccTrasLiq1 = await request(app).get(`/api/cc/contrapartes/${contraparteId}`);
    expect(ccTrasLiq1.body).toHaveLength(1);
    const filaLiq1 = ccTrasLiq1.body[0];
    // tipo COMPRA -> se le debe (haber) al productor
    expect(parseFloat(filaLiq1.haber)).toBeCloseTo(parseFloat(liq1.body.monto_neto_a_pagar), 2);
    expect(parseFloat(filaLiq1.saldo_acumulado)).toBeCloseTo(-parseFloat(liq1.body.monto_neto_a_pagar), 2);

    // Segundo movimiento + segunda liquidación, mismo contraparte
    const mov3 = await crearMovimientoConLlegada(30000);
    const liq2 = await request(app).post('/api/liquidaciones').send({
      tipo: 'COMPRA',
      modalidad: 'FORMAL',
      tipo_liquidacion: 'CONTADO',
      id_contrato: contratoId,
      id_contraparte: contraparteId,
      fecha_liquidacion: '2026-03-10',
      ids_movimientos: [mov3.id],
      moneda: 'PESOS',
    });
    expect(liq2.status).toBe(201);

    const ccTrasLiq2 = await request(app).get(`/api/cc/contrapartes/${contraparteId}`);
    expect(ccTrasLiq2.body).toHaveLength(2);
    const filaLiq2 = ccTrasLiq2.body.find(r => r.id_liquidacion === liq2.body.id);

    // HALLAZGO: cc_contrapartes.saldo_acumulado se graba como el neto de
    // ESA liquidación en soledad, no como saldo corriente (previo + este
    // movimiento). Si fuera realmente acumulado, este valor debería ser
    // filaLiq1.saldo_acumulado + (-liq2.monto_neto_a_pagar); en cambio es
    // igual a -liq2.monto_neto_a_pagar por sí solo, igual que si fuera la
    // primera liquidación de la cuenta.
    const acumuladoReal = parseFloat(filaLiq1.saldo_acumulado) - parseFloat(liq2.body.monto_neto_a_pagar);
    expect(parseFloat(filaLiq2.saldo_acumulado)).not.toBeCloseTo(acumuladoReal, 2);
    expect(parseFloat(filaLiq2.saldo_acumulado)).toBeCloseTo(-parseFloat(liq2.body.monto_neto_a_pagar), 2);

    // El endpoint de resumen SÍ calcula el total correcto vía SUM(debe-haber)
    // sobre todas las filas, así que el saldo agregado que ve el usuario en
    // /api/cc/resumen es correcto pese a que el campo saldo_acumulado de cada
    // fila individual no lo sea.
    const resumen = await request(app).get('/api/cc/resumen');
    const filaResumen = resumen.body.find(r => r.id === contraparteId);
    const totalEsperado = parseFloat(filaLiq1.debe) - parseFloat(filaLiq1.haber) + parseFloat(filaLiq2.debe) - parseFloat(filaLiq2.haber);
    expect(parseFloat(filaResumen.saldo)).toBeCloseTo(totalEsperado, 2);
  });
});
