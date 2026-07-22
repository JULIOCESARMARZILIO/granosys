// Prueba local (PGlite en memoria, ver __mocks__/pg.js) del nuevo endpoint
// GET /api/reportes/financiero: arma liquidaciones de granos en dos meses
// distintos y una preliquidación de flete, y verifica que el reporte separe
// correctamente "granos" de "fletes" tanto en la serie por período como en
// el ranking de acreedores.
jest.mock('pg');

const { buildTestApp } = require('../helpers/testApp');
const request = require('supertest');

describe('GET /api/reportes/financiero', () => {
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
      razon_social: 'Productor Financiero S.A.',
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
      cantidad_toneladas_pactadas: 200,
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

  async function crearMovimientoLiquidado(fechaLiquidacion, { transportista_nombre, tarifa_flete_real } = {}) {
    const alta = await request(app).post('/api/movimientos').send({
      modalidad: 'FORMAL',
      id_contrato_compra: contratoId,
      id_especie: especieId,
      id_campana: campanaId,
      peso_bruto_salida_kg: 30000,
      peso_tara_salida_kg: 15000,
      humedad_salida_pct: 13.5,
      usuario_carga: 'TEST_LOAD',
      transportista_nombre,
      tarifa_flete_real,
    });
    const mov = alta.body;

    await request(app).put(`/api/movimientos/${mov.id}/llegada`).send({
      fecha_arribo: `${fechaLiquidacion}T10:00:00Z`,
      fecha_descarga: `${fechaLiquidacion}T12:00:00Z`,
      nro_turno: '1',
      peso_bruto_llegada_kg: 30000,
      peso_tara_llegada_kg: 15000,
      humedad_llegada_pct: 13.5,
    });

    const liq = await request(app).post('/api/liquidaciones').send({
      tipo: 'COMPRA',
      modalidad: 'FORMAL',
      tipo_liquidacion: 'CONTADO',
      id_contrato: contratoId,
      id_contraparte: contraparteId,
      fecha_liquidacion: fechaLiquidacion,
      ids_movimientos: [mov.id],
      moneda: 'PESOS',
    });
    expect(liq.status).toBe(201);

    return mov;
  }

  test('separa granos (por mes) de fletes y arma el ranking de acreedores', async () => {
    // Dos liquidaciones de granos en meses distintos, mismo productor.
    // El transportista debe ser uno YA REGISTRADO (sembrado por initDB): la
    // ruta de facturación busca la razón social exacta en `transportistas`
    // y rechaza (400) nombres que no coincidan con ninguno existente.
    await crearMovimientoLiquidado('2026-03-05', { transportista_nombre: 'Logística Centro S.R.L.', tarifa_flete_real: 5 });
    await crearMovimientoLiquidado('2026-04-10');

    // Preliquidar y facturar el flete del primer movimiento (usa CURRENT_DATE)
    const movs = (await request(app).get('/api/movimientos')).body;
    const movConFlete = movs.find(m => m.transportista_nombre === 'Logística Centro S.R.L.');
    expect(movConFlete).toBeDefined();

    const preliq = await request(app).put('/api/movimientos/bulk-preliquidar').send({ ids: [movConFlete.id] });
    expect(preliq.status).toBe(200);
    const codigo = preliq.body.resultados[0].codigo;

    const facturar = await request(app).put(`/api/movimientos/preliquidaciones/${codigo}/facturar`).send({
      nro_factura_flete: 'FC-0001',
    });
    expect(facturar.status).toBe(200);

    // Rango amplio para no depender de qué día real corre la suite (CURRENT_DATE del flete)
    const reporte = await request(app)
      .get('/api/reportes/financiero')
      .query({ desde: '2020-01-01', hasta: '2030-01-01', agrupacion: 'mes' });
    expect(reporte.status).toBe(200);

    const { por_periodo, por_acreedor } = reporte.body;

    const marzo = por_periodo.find(p => p.periodo === '2026-03');
    const abril = por_periodo.find(p => p.periodo === '2026-04');
    expect(marzo).toBeDefined();
    expect(abril).toBeDefined();
    expect(marzo.granos_neto).toBeGreaterThan(0);
    expect(abril.granos_neto).toBeGreaterThan(0);
    // El flete se factura con CURRENT_DATE, no con la fecha de liquidación de marzo
    expect(marzo.fletes_neto).toBe(0);

    const totalFletesEnAlgunPeriodo = por_periodo.some(p => p.fletes_neto > 0);
    expect(totalFletesEnAlgunPeriodo).toBe(true);

    const acreedorGranos = por_acreedor.find(a => a.categoria === 'GRANOS' && a.nombre === 'Productor Financiero S.A.');
    expect(acreedorGranos).toBeDefined();
    expect(acreedorGranos.monto_adeudado).toBeGreaterThan(0);
    expect(acreedorGranos.movimientos).toBe(2);

    const acreedorFletes = por_acreedor.find(a => a.categoria === 'FLETES' && a.nombre === 'Logística Centro S.R.L.');
    expect(acreedorFletes).toBeDefined();
    expect(acreedorFletes.monto_adeudado).toBeGreaterThan(0);
  });

  test('valida los parámetros de entrada', async () => {
    const sinFechas = await request(app).get('/api/reportes/financiero').query({ agrupacion: 'dia' });
    expect(sinFechas.status).toBe(400);

    const agrupacionInvalida = await request(app)
      .get('/api/reportes/financiero')
      .query({ desde: '2026-01-01', hasta: '2026-12-31', agrupacion: 'trimestre' });
    expect(agrupacionInvalida.status).toBe(400);
  });
});
