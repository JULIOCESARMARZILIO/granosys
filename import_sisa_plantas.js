require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./src/db');

const SISA_FILE = process.env.SISA_FILE || path.join(
  'C:/Users/jcmar/AppData/Local/Temp/claude/C--Users-jcmar-Desktop-granosys-main/333b2abb-0334-4259-8c40-623666955524/scratchpad/sisa/sisa-plantas-activas.txt'
);

const DRY_RUN = !process.argv.includes('--commit');

// Provincias principales de grano + excepcion algodon (Chaco/Santiago del Estero)
const PROVINCIAS_GRANO = ['BUENOS AIRES', 'SANTA FE', 'CORDOBA', 'LA PAMPA'];
const PROVINCIAS_ALGODON = ['CHACO', 'SANTIAGO DEL ESTERO'];

// Actividad SISA -> tipo interno de ubicaciones. Todo lo que no esta en este
// mapa se descarta (arroz, fraccionadores, mayoristas, deposito transitorio,
// explotador de deposito generico, semillero, usuario industria).
const ACTIVIDAD_A_TIPO = {
  'ACOPIADOR - CONSIGNATARIO': 'ACOPIO',
  'PLANTA DE ACOPIO DE PRODUCTOR': 'ACOPIO',
  'INDUSTRIAL ACEITERO': 'ACEITERA',
  'INDUSTRIAL DE GRANOS Y/O SUBPRODUCTOS': 'INDUSTRIAL',
  'INDUSTRIAL MOLINERO': 'MOLINO',
  'INDUSTRIAL MOLINO DE HARINA DE TRIGO': 'MOLINO',
  'INDUSTRIAL BALANCEADOR': 'BALANCEADORA',
  'INDUSTRIAL BIOCOMBUSTIBLES': 'BIOCOMBUSTIBLE',
  'INDUSTRIAL DESTILER\u00cdA / FERMENTADOR': 'DESTILERIA',
  'DEP\u00d3SITO FISCAL': 'DEPOSITO_FISCAL',
  'ACONDICIONADOR': 'ACONDICIONADOR',
};
// Version sin tildes (el archivo viene en latin1, por las dudas de mismatch)
const ACTIVIDAD_A_TIPO_ASCII = {
  'ACOPIADOR - CONSIGNATARIO': 'ACOPIO',
  'PLANTA DE ACOPIO DE PRODUCTOR': 'ACOPIO',
  'INDUSTRIAL ACEITERO': 'ACEITERA',
  'INDUSTRIAL DE GRANOS Y/O SUBPRODUCTOS': 'INDUSTRIAL',
  'INDUSTRIAL MOLINERO': 'MOLINO',
  'INDUSTRIAL MOLINO DE HARINA DE TRIGO': 'MOLINO',
  'INDUSTRIAL BALANCEADOR': 'BALANCEADORA',
  'INDUSTRIAL BIOCOMBUSTIBLES': 'BIOCOMBUSTIBLE',
  'INDUSTRIAL DESTILERIA / FERMENTADOR': 'DESTILERIA',
  'DEPOSITO FISCAL': 'DEPOSITO_FISCAL',
  'ACONDICIONADOR': 'ACONDICIONADOR',
};

const ACTIVIDAD_ALGODON = 'DESMOTADORA Y/O DESLINTADORA DE ALGODON';
const ACTIVIDAD_EXPLOTADOR = 'EXPLOTADOR DE DEPOSITO Y/O ELEVADOR Y/O TRANSBORDADOR DE GRANOS Y/O DERIVADOS GRANARIOS';

// Localidades con zona/sub_zona puntual ya decidida
const LOCALIDAD_ZONA = {
  'TANDIL': { zona: 'Sur', sub_zona: 'Tandil' },
  'NECOCHEA': { zona: 'Sur', sub_zona: 'Necochea' },
  'QUEQUEN': { zona: 'Sur', sub_zona: 'Necochea' },
  'BAHIA BLANCA': { zona: 'Sur', sub_zona: 'Bahia Blanca' },
  'INGENIERO WHITE': { zona: 'Sur', sub_zona: 'Bahia Blanca' },
  'SALADILLO': { zona: 'Saladillo', sub_zona: null },
  'CANUELAS': { zona: 'Saladillo', sub_zona: null },
  'ROQUE PEREZ': { zona: 'Saladillo', sub_zona: null },
  '25 DE MAYO': { zona: 'Saladillo', sub_zona: null },
};

// Direcciones puntuales conseguidas por busqueda web (empresas grandes/conocidas).
// Clave: CUIT sin guiones.
const DIRECCIONES_CONOCIDAS = {
  '30656161341': 'Av. Juan de Garay 850, Quequen (CP 7631)', // Terminal Quequen S.A.
  '30660168105': 'Carrega N\u00b0 3900 (Puente La Ni\u00f1a), Ingeniero White', // Terminal Bahia Blanca S.A.
};

function normalizarProvincia(p) {
  return (p || '').trim().toUpperCase()
    .replace(/\u00d1/g, 'N')
    .replace(/[\u00c1\u00c0]/g, 'A').replace(/[\u00c9\u00c8]/g, 'E')
    .replace(/[\u00cd\u00cc]/g, 'I').replace(/[\u00d3\u00d2]/g, 'O')
    .replace(/[\u00da\u00d9]/g, 'U');
}

function normalizarLocalidad(l) {
  return (l || '').trim().toUpperCase()
    .replace(/\u00d1/g, 'N')
    .replace(/[\u00c1\u00c0]/g, 'A').replace(/[\u00c9\u00c8]/g, 'E')
    .replace(/[\u00cd\u00cc]/g, 'I').replace(/[\u00d3\u00d2]/g, 'O')
    .replace(/[\u00da\u00d9]/g, 'U')
    .replace(/\s*\([^)]*\)\s*$/, ''); // saca "(BAHIA BLANCA)" de "BAJO HONDO(BAHIA BLANCA)"
}

function parseSisa(filePath) {
  const raw = fs.readFileSync(filePath, 'latin1');
  const lines = raw.split(/\r?\n/).slice(3); // saltea las 3 lineas de cabecera
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(';');
    if (parts.length < 6) continue;
    const [cuit, denominacion, actividad, nro_planta, provincia, localidad] = parts;
    rows.push({
      cuit: (cuit || '').trim(),
      denominacion: (denominacion || '').trim(),
      actividad: (actividad || '').trim(),
      nro_planta: (nro_planta || '').trim(),
      provincia: (provincia || '').trim(),
      localidad: (localidad || '').trim(),
    });
  }
  return rows;
}

function clasificar(row) {
  const provinciaNorm = normalizarProvincia(row.provincia);
  const actividadNorm = row.actividad.replace(/\u00d1/g, 'N')
    .replace(/[\u00c1\u00c0]/g, 'A').replace(/[\u00c9\u00c8]/g, 'E')
    .replace(/[\u00cd\u00cc]/g, 'I').replace(/[\u00d3\u00d2]/g, 'O')
    .replace(/[\u00da\u00d9]/g, 'U');

  // Caso especial: algodon, solo Chaco/Santiago del Estero
  if (actividadNorm === ACTIVIDAD_ALGODON) {
    if (PROVINCIAS_ALGODON.includes(provinciaNorm)) {
      return { tipo: 'DESMOTADORA', zona: 'Algodon', sub_zona: null };
    }
    return null;
  }

  // Filtro de provincia general (para todo lo demas)
  if (!PROVINCIAS_GRANO.includes(provinciaNorm)) return null;

  // Caso especial: explotador de deposito/elevador -> solo terminales de
  // puerto reales (heuristica: nombre contiene "TERMINAL")
  if (actividadNorm === ACTIVIDAD_EXPLOTADOR) {
    if (/TERMINAL/i.test(row.denominacion)) {
      return { tipo: 'PUERTO', zona: null, sub_zona: null };
    }
    return null;
  }

  const tipo = ACTIVIDAD_A_TIPO_ASCII[actividadNorm] || ACTIVIDAD_A_TIPO[row.actividad];
  if (!tipo) return null;

  let zona = null, sub_zona = null;
  if (tipo === 'DEPOSITO_FISCAL') {
    zona = 'Depositos Fiscales';
  } else {
    const localidadNorm = normalizarLocalidad(row.localidad);
    const zl = LOCALIDAD_ZONA[localidadNorm];
    if (zl) { zona = zl.zona; sub_zona = zl.sub_zona; }
  }

  return { tipo, zona, sub_zona };
}

async function main() {
  const rows = parseSisa(SISA_FILE);
  console.log(`Lineas de datos leidas: ${rows.length}`);

  const seleccionadas = [];
  for (const row of rows) {
    const clasif = clasificar(row);
    if (!clasif) continue;
    seleccionadas.push({ ...row, ...clasif });
  }

  console.log(`Registros que matchean los filtros: ${seleccionadas.length}`);

  // Resumen por tipo
  const porTipo = {};
  for (const r of seleccionadas) porTipo[r.tipo] = (porTipo[r.tipo] || 0) + 1;
  console.log('\nPor tipo:');
  for (const [tipo, count] of Object.entries(porTipo).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tipo}: ${count}`);
  }

  // Resumen por provincia
  const porProvincia = {};
  for (const r of seleccionadas) {
    const p = normalizarProvincia(r.provincia);
    porProvincia[p] = (porProvincia[p] || 0) + 1;
  }
  console.log('\nPor provincia:');
  for (const [p, count] of Object.entries(porProvincia).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p}: ${count}`);
  }

  // Resumen por zona
  const porZona = {};
  for (const r of seleccionadas) {
    const z = r.zona || '(sin zona)';
    porZona[z] = (porZona[z] || 0) + 1;
  }
  console.log('\nPor zona:');
  for (const [z, count] of Object.entries(porZona).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${z}: ${count}`);
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No se inserto nada. Corre con --commit para insertar de verdad.');
    console.log('\nMuestra de 15 registros que se insertarian:');
    seleccionadas.slice(0, 15).forEach(r => {
      console.log(`  ${r.cuit} | ${r.denominacion} | ${r.tipo} | planta ${r.nro_planta} | ${r.localidad}, ${r.provincia} | zona=${r.zona || '-'}`);
    });
    await pool.end();
    return;
  }

  // Evitar duplicados en reruns: traer combinaciones cuit+nro_planta+tipo ya cargadas
  const { rows: existentes } = await pool.query(
    `SELECT cuit_titular, nro_planta, tipo FROM ubicaciones WHERE cuit_titular IS NOT NULL AND nro_planta IS NOT NULL`
  );
  const yaExiste = new Set(existentes.map(e => `${e.cuit_titular}|${e.nro_planta}|${e.tipo}`));

  let insertados = 0, saltados = 0;
  for (const r of seleccionadas) {
    const key = `${r.cuit}|${r.nro_planta}|${r.tipo}`;
    if (yaExiste.has(key)) { saltados++; continue; }
    const direccion = DIRECCIONES_CONOCIDAS[r.cuit] || null;
    await pool.query(
      `INSERT INTO ubicaciones (nombre, tipo, localidad, provincia, direccion, cuit_titular, nro_planta, zona, sub_zona, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,
      [r.denominacion, r.tipo, r.localidad || null, r.provincia || null, direccion, r.cuit || null, r.nro_planta || null, r.zona, r.sub_zona]
    );
    yaExiste.add(key);
    insertados++;
  }

  console.log(`\nInsertados: ${insertados}`);
  console.log(`Saltados (ya existian): ${saltados}`);
  await pool.end();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
