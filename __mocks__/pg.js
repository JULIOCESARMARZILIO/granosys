// Mock del módulo "pg" usado en los tests.
//
// src/db.js hace `const { Pool } = require('pg')` y se conecta con
// process.env.DATABASE_URL. Jest reemplaza automáticamente ese require por
// este archivo en cualquier test (manual mock de un paquete de node_modules),
// así que ninguna consulta de los tests abre jamás una conexión real de red:
// no hay forma de que un test toque la base de datos de producción en Railway.
//
// En vez de simular Postgres, usamos PGlite: es Postgres real compilado a
// WASM y corriendo embebido en memoria. Esto importa porque el esquema de
// GranoSYS usa tipos y sintaxis específicos de Postgres (NUMERIC(p,s), ILIKE,
// RETURNING, ANY($1) sobre arrays, ON CONFLICT, TIMESTAMP DEFAULT NOW()) que
// un emulador liviano (ej. pg-mem) no soporta del todo — se probó y falla al
// crear la tabla parametros_calidad_especie por el NUMERIC(8,3). PGlite, al
// ser Postgres de verdad, ejecuta el mismo SQL que usa la app en producción.
const { PGlite } = require('@electric-sql/pglite');

const db = new PGlite();

function wrapResult(result) {
  return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
}

// Postgres distingue protocolo simple (permite varias sentencias separadas
// por ";", sin parámetros) del protocolo extendido (una sola sentencia, con
// $1/$2/...). El driver real "pg" elige uno u otro según se pasen params o
// no; acá replicamos esa misma regla para que los bloques multi-sentencia de
// db.js (creación de tablas, migraciones) sigan funcionando igual.
async function run(text, params) {
  if (!params || params.length === 0) {
    const results = await db.exec(text);
    return wrapResult(results[results.length - 1] || { rows: [] });
  }
  return wrapResult(await db.query(text, params));
}

class Client {
  async connect() {}
  async query(text, params) {
    return run(text, params);
  }
  release() {}
  async end() {}
}

class Pool {
  constructor() {}
  async query(text, params) {
    return run(text, params);
  }
  async connect() {
    return new Client();
  }
  async end() {}
  on() {}
}

module.exports = { Pool, Client };
