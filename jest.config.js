module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  // La carga de PGlite (Postgres embebido en WASM) y la siembra de ~470 filas
  // de mermas_humedad + 100 movimientos + 50 contratos puede superar el timeout
  // por defecto de Jest (5s), especialmente en la primera corrida.
  testTimeout: 60000,
  // El repo tiene una copia anidada del proyecto en ./granosys-main (con su
  // propio package.json "granosys"), lo que choca con el haste map de Jest
  // ("naming collision"). Se excluye de la exploración de módulos y tests.
  modulePathIgnorePatterns: ['<rootDir>/granosys-main'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/granosys-main'],
  // PGlite (Postgres embebido en WASM) deja handles internos abiertos que
  // Jest no puede detectar como cerrados; sin esto el proceso queda colgado
  // ~1s extra al final aunque todos los tests ya hayan terminado.
  forceExit: true,
};
