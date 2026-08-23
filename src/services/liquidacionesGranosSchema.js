const TIPOS_LIQUIDACION = Object.freeze(['PRIMARIA', 'SECUNDARIA']);

const TIPOS_CONCEPTO = Object.freeze([
  'MERCADERIA', 'BONIFICACION', 'REBAJA_CALIDAD', 'MERMA', 'SECADA',
  'ZARANDA', 'FLETE', 'COMISION', 'ALMACENAJE', 'PARITARIA',
  'FUMIGACION', 'SELLADO', 'AJUSTE', 'OTRO'
]);

const TIPOS_IMPUESTO = Object.freeze([
  'IVA', 'GANANCIAS', 'SISA', 'IIBB', 'SELLOS', 'PERCEPCION_IVA',
  'PERCEPCION_IIBB', 'OTRO'
]);

function validarAlicuotaIva(value) {
  if (value === null || value === undefined || value === '') return null;
  const alicuota = Number(value);
  if (!Number.isFinite(alicuota) || alicuota < 0 || alicuota > 100) {
    throw new Error('La alicuota de IVA debe estar entre 0 y 100.');
  }
  return alicuota;
}

function normalizarConcepto(concepto = {}) {
  const tipo = String(concepto.tipo || 'OTRO').toUpperCase();
  if (!TIPOS_CONCEPTO.includes(tipo)) throw new Error(`Tipo de concepto invalido: ${tipo}`);
  const cantidad = Number(concepto.cantidad || 0);
  const importeNeto = Number(concepto.importeNeto ?? concepto.importe_neto ?? 0);
  const alicuotaIva = validarAlicuotaIva(concepto.alicuotaIva ?? concepto.alicuota_iva);
  const importeIva = Number(concepto.importeIva ?? concepto.importe_iva ?? (importeNeto * (alicuotaIva || 0) / 100));
  if (![cantidad, importeNeto, importeIva].every(Number.isFinite)) throw new Error('Importes invalidos en concepto.');
  return {
    tipo,
    codigoOficial: concepto.codigoOficial || concepto.codigo_oficial || null,
    descripcion: concepto.descripcion || tipo,
    cantidad,
    unidad: concepto.unidad || null,
    precioUnitario: Number(concepto.precioUnitario ?? concepto.precio_unitario ?? 0),
    importeNeto,
    alicuotaIva,
    importeIva,
    importeTotal: Number(concepto.importeTotal ?? concepto.importe_total ?? (importeNeto + importeIva)),
    signo: String(concepto.signo || 'SUMA').toUpperCase(),
    metadata: concepto.metadata || {}
  };
}

function calcularTotales(conceptos = [], impuestos = []) {
  const normalizados = conceptos.map(normalizarConcepto);
  const suma = normalizados.filter(item => item.signo !== 'RESTA');
  const resta = normalizados.filter(item => item.signo === 'RESTA');
  const total = (items, field) => items.reduce((acc, item) => acc + Number(item[field] || 0), 0);
  const neto = total(suma, 'importeNeto') - total(resta, 'importeNeto');
  const iva = total(suma, 'importeIva') - total(resta, 'importeIva');
  const descuentosConceptos = total(resta, 'importeTotal');
  const brutoConceptos = total(suma, 'importeNeto');
  const retenciones = impuestos.reduce((acc, item) => {
    return acc + (String(item.signo || 'RESTA').toUpperCase() === 'RESTA' ? Number(item.importe || 0) : 0);
  }, 0);
  const tributos = impuestos.reduce((acc, item) => acc + Number(item.importe || 0) * (String(item.signo || 'RESTA').toUpperCase() === 'SUMA' ? 1 : -1), 0);
  return {
    neto,
    iva,
    iva105: normalizados.filter(item => Number(item.alicuotaIva) === 10.5).reduce((a, item) => a + item.importeIva * (item.signo === 'RESTA' ? -1 : 1), 0),
    iva21: normalizados.filter(item => Number(item.alicuotaIva) === 21).reduce((a, item) => a + item.importeIva * (item.signo === 'RESTA' ? -1 : 1), 0),
    brutoConceptos,
    descuentosConceptos,
    retenciones,
    tributos,
    total: neto + iva + tributos
  };
}

async function ensureLiquidacionesGranosSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS liquidaciones_primarias (
      id BIGSERIAL PRIMARY KEY,
      id_liquidacion INTEGER NOT NULL UNIQUE REFERENCES liquidaciones(id) ON DELETE CASCADE,
      coe VARCHAR(20),
      numero_lpg VARCHAR(40),
      cuit_liquidador VARCHAR(11),
      cuit_productor VARCHAR(11),
      id_certificado_1116 INTEGER REFERENCES certificados_1116(id) ON DELETE SET NULL,
      kilos_brutos NUMERIC(14,3),
      kilos_netos NUMERIC(14,3),
      kilos_liquidados NUMERIC(14,3),
      precio_tonelada NUMERIC(18,6),
      fecha_operacion DATE,
      fecha_pago DATE,
      metadata_oficial JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS liquidaciones_secundarias (
      id BIGSERIAL PRIMARY KEY,
      id_liquidacion INTEGER NOT NULL UNIQUE REFERENCES liquidaciones(id) ON DELETE CASCADE,
      coe VARCHAR(20),
      numero_lsg VARCHAR(40),
      cuit_emisor VARCHAR(11),
      cuit_vendedor VARCHAR(11),
      cuit_comprador VARCHAR(11),
      cuit_corredor_consignatario VARCHAR(11),
      kilos_liquidados NUMERIC(14,3),
      precio_tonelada NUMERIC(18,6),
      fecha_operacion DATE,
      fecha_pago DATE,
      metadata_oficial JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS liquidacion_conceptos (
      id BIGSERIAL PRIMARY KEY,
      id_liquidacion INTEGER NOT NULL REFERENCES liquidaciones(id) ON DELETE CASCADE,
      orden INTEGER NOT NULL DEFAULT 0,
      tipo VARCHAR(30) NOT NULL,
      codigo_oficial VARCHAR(50),
      descripcion VARCHAR(250) NOT NULL,
      cantidad NUMERIC(18,6),
      unidad VARCHAR(20),
      precio_unitario NUMERIC(18,6),
      importe_neto NUMERIC(18,4) NOT NULL DEFAULT 0,
      alicuota_iva NUMERIC(7,4),
      importe_iva NUMERIC(18,4) NOT NULL DEFAULT 0,
      importe_total NUMERIC(18,4) NOT NULL DEFAULT 0,
      signo VARCHAR(10) NOT NULL DEFAULT 'SUMA',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (alicuota_iva IS NULL OR (alicuota_iva >= 0 AND alicuota_iva <= 100)),
      CHECK (signo IN ('SUMA','RESTA'))
    );

    CREATE TABLE IF NOT EXISTS liquidacion_impuestos (
      id BIGSERIAL PRIMARY KEY,
      id_liquidacion INTEGER NOT NULL REFERENCES liquidaciones(id) ON DELETE CASCADE,
      orden INTEGER NOT NULL DEFAULT 0,
      tipo VARCHAR(30) NOT NULL,
      regimen VARCHAR(60),
      descripcion VARCHAR(250) NOT NULL,
      base_imponible NUMERIC(18,4),
      alicuota NUMERIC(9,6),
      importe NUMERIC(18,4) NOT NULL DEFAULT 0,
      signo VARCHAR(10) NOT NULL DEFAULT 'RESTA',
      caracter VARCHAR(20) NOT NULL DEFAULT 'PRACTICADA',
      computabilidad VARCHAR(30),
      numero_certificado VARCHAR(60),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (signo IN ('SUMA','RESTA')),
      CHECK (caracter IN ('PRACTICADA','SUFRIDA','PERCEPCION','OTRO'))
    );

    CREATE TABLE IF NOT EXISTS liquidacion_relaciones (
      id BIGSERIAL PRIMARY KEY,
      id_liquidacion INTEGER NOT NULL REFERENCES liquidaciones(id) ON DELETE CASCADE,
      id_liquidacion_relacionada INTEGER REFERENCES liquidaciones(id) ON DELETE RESTRICT,
      id_documento_arca BIGINT REFERENCES arca_official_documents(id) ON DELETE SET NULL,
      id_certificado_1116 INTEGER REFERENCES certificados_1116(id) ON DELETE SET NULL,
      tipo_relacion VARCHAR(40) NOT NULL,
      importe_aplicado NUMERIC(18,4),
      kilos_aplicados NUMERIC(14,3),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_liq_primaria_coe ON liquidaciones_primarias(coe);
    CREATE INDEX IF NOT EXISTS idx_liq_secundaria_coe ON liquidaciones_secundarias(coe);
    CREATE INDEX IF NOT EXISTS idx_liq_conceptos_liq ON liquidacion_conceptos(id_liquidacion, orden, id);
    CREATE INDEX IF NOT EXISTS idx_liq_impuestos_liq ON liquidacion_impuestos(id_liquidacion, orden, id);
    CREATE INDEX IF NOT EXISTS idx_liq_relaciones_liq ON liquidacion_relaciones(id_liquidacion, tipo_relacion);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_liq_primaria_coe ON liquidaciones_primarias(coe) WHERE coe IS NOT NULL AND coe <> '';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_liq_secundaria_coe ON liquidaciones_secundarias(coe) WHERE coe IS NOT NULL AND coe <> '';
  `);
}

module.exports = {
  TIPOS_LIQUIDACION,
  TIPOS_CONCEPTO,
  TIPOS_IMPUESTO,
  validarAlicuotaIva,
  normalizarConcepto,
  calcularTotales,
  ensureLiquidacionesGranosSchema
};

