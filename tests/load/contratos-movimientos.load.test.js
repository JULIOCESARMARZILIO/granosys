// Suite de carga: simula el alta de 50 contratos y 100 movimientos contables
// a través de las rutas HTTP reales de la app (los mismos endpoints que usa
// el frontend), pero corriendo 100% en local:
//
//   - jest.mock('pg') reemplaza el driver de PostgreSQL por PGlite (Postgres
//     embebido en memoria) -- ver __mocks__/pg.js. Nunca se abre una conexión
//     de red, así que es estructuralmente imposible que esta suite lea o
//     escriba en la base de datos de producción de Railway.
//   - Cada archivo de test de Jest corre en su propio registro de módulos, así
//     que esta suite arranca con una base vacía y descartable.
//
// No hace falta ninguna variable de entorno (DATABASE_URL, etc.) para correr
// estos tests: node_modules/.bin/jest tests/load ya alcanza.
jest.mock('pg');

const { buildTestApp } = require('../helpers/testApp');
const request = require('supertest');

const CANTIDAD_CONTRATOS = 50;
const CANTIDAD_MOVIMIENTOS = 100;

const LOCALIDADES = [
  { localidad: 'Rosario', provincia: 'Santa Fe' },
  { localidad: 'Rafaela', provincia: 'Santa Fe' },
  { localidad: 'La Banda', provincia: 'Santiago del Estero' },
  { localidad: 'Bell Ville', provincia: 'Córdoba' },
  { localidad: 'Pergamino', provincia: 'Buenos Aires' },
];

function pick(arr, i) {
  return arr[i % arr.length];
}

describe('Carga masiva local (50 contratos + 100 movimientos)', () => {
  let app;
  let especies; // los "cultivos" ya sembrados por initDB(): Soja, Trigo, Maíz, Girasol, Sorgo, Cebada
  let campanaActivaId;
  let contrapartes = [];
  let contratosCreados = [];
  let movimientosCreados = [];

  beforeAll(async () => {
    app = await buildTestApp();

    const especiesRes = await request(app).get('/api/especies');
    expect(especiesRes.status).toBe(200);
    especies = especiesRes.body;
    expect(especies.length).toBeGreaterThan(0);

    const campanasRes = await request(app).get('/api/campanas');
    expect(campanasRes.status).toBe(200);
    const activa = campanasRes.body.find(c => c.activa) || campanasRes.body[0];
    campanaActivaId = activa.id;

    // Contrapartes necesarias para poder asociar cada contrato a alguien
    // (comprador o productor). No son el foco de esta suite, así que se crea
    // un pool chico y se reutiliza entre contratos.
    for (let i = 0; i < 5; i++) {
      const tipo = i % 2 === 0 ? 'COMPRADOR' : 'PRODUCTOR';
      const res = await request(app).post('/api/contrapartes').send({
        cuit: `30-7102061${i}-4`,
        razon_social: `Contraparte de Prueba ${i + 1}`,
        tipo_contraparte: tipo,
        canal_operacion: 'FORMAL',
        condicion_iva: 'RI',
      });
      expect(res.status).toBe(201);
      contrapartes.push(res.body);
    }
  });

  test(`crea ${CANTIDAD_CONTRATOS} contratos usando las especies (cultivos) sembradas`, async () => {
    const t0 = Date.now();

    for (let i = 0; i < CANTIDAD_CONTRATOS; i++) {
      const especie = pick(especies, i);
      const contraparte = pick(contrapartes, i);
      const { localidad, provincia } = pick(LOCALIDADES, i);
      const tipoContrato = i % 2 === 0 ? 'COMPRA' : 'VENTA';

      const res = await request(app).post('/api/contratos').send({
        tipo_contrato: tipoContrato,
        modalidad: 'FORMAL',
        tipo_liquidacion: 'CONTADO',
        fecha_contrato: '2026-03-01',
        id_contraparte: contraparte.id,
        id_especie: especie.id,
        id_campana: campanaActivaId,
        cantidad_toneladas_pactadas: 100 + (i % 10) * 50,
        tipo_precio: 'FIJO',
        moneda: 'PESOS',
        precio_pactado: 200 + (i % 20) * 5,
        tipo_entrega: 'PUESTO_DESTINO',
        localidad_entrega: localidad,
        provincia_entrega: provincia,
        forma_pago: 'CONTADO',
        condicion_pago: 'CONTADO',
      });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      contratosCreados.push({ ...res.body, especieId: especie.id });
    }

    const elapsedMs = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[carga] ${CANTIDAD_CONTRATOS} contratos creados en ${elapsedMs}ms`);

    expect(contratosCreados).toHaveLength(CANTIDAD_CONTRATOS);
    const numerosUnicos = new Set(contratosCreados.map(c => c.numero_contrato));
    expect(numerosUnicos.size).toBe(CANTIDAD_CONTRATOS);

    const listado = await request(app).get('/api/contratos');
    expect(listado.status).toBe(200);
    expect(listado.body).toHaveLength(CANTIDAD_CONTRATOS);
  });

  test(`crea ${CANTIDAD_MOVIMIENTOS} movimientos contables distribuidos entre los contratos`, async () => {
    expect(contratosCreados.length).toBe(CANTIDAD_CONTRATOS);
    const t0 = Date.now();

    for (let i = 0; i < CANTIDAD_MOVIMIENTOS; i++) {
      const contrato = pick(contratosCreados, i);
      const esCompra = contrato.tipo_contrato === 'COMPRA';
      const pesoBruto = 30000 + (i % 15) * 500;
      const pesoTara = 14000 + (i % 5) * 100;

      const payload = {
        modalidad: 'FORMAL', // FORMAL evita la lógica de "gemelo" INFORMAL+CPE de movimientos.js
        id_especie: contrato.especieId,
        id_campana: campanaActivaId,
        peso_bruto_salida_kg: pesoBruto,
        peso_tara_salida_kg: pesoTara,
        humedad_salida_pct: 13 + (i % 5) * 0.5,
        localidad_origen: pick(LOCALIDADES, i).localidad,
        provincia_origen: pick(LOCALIDADES, i).provincia,
        usuario_carga: 'TEST_LOAD',
      };
      if (esCompra) {
        payload.id_contrato_compra = contrato.id;
      } else {
        payload.id_contrato_venta = contrato.id;
      }

      const res = await request(app).post('/api/movimientos').send(payload);

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      movimientosCreados.push(res.body);
    }

    const elapsedMs = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[carga] ${CANTIDAD_MOVIMIENTOS} movimientos creados en ${elapsedMs}ms`);

    expect(movimientosCreados).toHaveLength(CANTIDAD_MOVIMIENTOS);
    const numerosUnicos = new Set(movimientosCreados.map(m => m.numero_movimiento));
    expect(numerosUnicos.size).toBe(CANTIDAD_MOVIMIENTOS);

    const listado = await request(app).get('/api/movimientos');
    expect(listado.status).toBe(200);
    expect(listado.body).toHaveLength(CANTIDAD_MOVIMIENTOS);
  });

  test('recalcularContrato() actualizó toneladas asignadas y estado tras cargar movimientos', async () => {
    const contratoConMovimiento = contratosCreados[0];
    const res = await request(app).get(`/api/contratos/${contratoConMovimiento.id}`);

    expect(res.status).toBe(200);
    expect(parseFloat(res.body.cantidad_toneladas_asignadas)).toBeGreaterThan(0);
    expect(res.body.movimientos.length).toBeGreaterThan(0);
    expect(['EN_CURSO', 'CUMPLIDO']).toContain(res.body.estado);
  });

  test('los movimientos quedan asociados a alguno de los 6 cultivos sembrados', async () => {
    const codigosValidos = new Set(especies.map(e => e.codigo));
    const listado = await request(app).get('/api/movimientos');

    const codigosUsados = new Set(
      listado.body.map(m => especies.find(e => e.id === m.id_especie)?.codigo).filter(Boolean)
    );
    expect(codigosUsados.size).toBeGreaterThan(0);
    for (const codigo of codigosUsados) {
      expect(codigosValidos.has(codigo)).toBe(true);
    }
  });
});
