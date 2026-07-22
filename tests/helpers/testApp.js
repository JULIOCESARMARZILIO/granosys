const express = require('express');

// Construye una app Express de test montando los routers reales de GranoSYS
// (los mismos require de src/index.js) contra la base de datos embebida que
// entrega __mocks__/pg.js. El archivo de test que use este helper debe llamar
// `jest.mock('pg')` antes de requerirlo, para que src/db.js reciba la base en
// memoria en lugar de intentar conectarse a PostgreSQL real.
async function buildTestApp() {
  const { initDB } = require('../../src/db');
  await initDB();

  const app = express();
  app.use(express.json());
  app.use('/api/contrapartes', require('../../src/routes/contrapartes'));
  app.use('/api/especies', require('../../src/routes/especies'));
  app.use('/api/campanas', require('../../src/routes/campanas'));
  app.use('/api/contratos', require('../../src/routes/contratos'));
  app.use('/api/movimientos', require('../../src/routes/movimientos'));
  app.use('/api/liquidaciones', require('../../src/routes/liquidaciones'));
  app.use('/api/cc', require('../../src/routes/cuentacorriente'));
  app.use('/api/stock', require('../../src/routes/stock'));
  app.use('/api/reportes', require('../../src/routes/reportes'));

  return app;
}

module.exports = { buildTestApp };
