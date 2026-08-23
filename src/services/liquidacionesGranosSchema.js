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
      -- arca_official_documents se crea de forma diferida por el cliente ARCA.
      -- Se conserva el identificador sin FK para que el arranque no dependa
      -- del orden de inicializacion de una integracion externa.
      id_documento_arca BIGINT,
      id_certificado_1116 INTEGER REFERENCES certificados_1116(id) ON DELETE SET NULL,
      tipo_relacion VARCHAR(40) NOT NULL,
      importe_aplicado NUMERIC(18,4),
      kilos_aplicados NUMERIC(14,3),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS liquidacion_datos_oficiales (
      id_liquidacion INTEGER PRIMARY KEY REFERENCES liquidaciones(id) ON DELETE CASCADE,
      fuente VARCHAR(40),
      familia_documento VARCHAR(80),
      tipo_formulario_historico VARCHAR(80),
      codigo_operacion VARCHAR(30),
      descripcion_operacion VARCHAR(200),
      sistema_emision VARCHAR(30),
      estado_oficial VARCHAR(40),
      fecha_emision TIMESTAMPTZ,
      fecha_anulacion TIMESTAMPTZ,
      punto_emision INTEGER,
      numero_comprobante BIGINT,
      moneda VARCHAR(10),
      tipo_cambio NUMERIC(18,8),
      importe_bruto NUMERIC(18,4),
      importe_neto_gravado NUMERIC(18,4),
      importe_no_gravado NUMERIC(18,4),
      importe_exento NUMERIC(18,4),
      importe_iva NUMERIC(18,4),
      importe_tributos NUMERIC(18,4),
      importe_retenciones NUMERIC(18,4),
      importe_percepciones NUMERIC(18,4),
      importe_total NUMERIC(18,4),
      saldo_pagable NUMERIC(18,4),
      payload_oficial JSONB NOT NULL DEFAULT '{}'::jsonb,
      payload_hash VARCHAR(64),
      version_esquema VARCHAR(30),
      sincronizado_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS liquidacion_participantes (
      id BIGSERIAL PRIMARY KEY,
      id_liquidacion INTEGER NOT NULL REFERENCES liquidaciones(id) ON DELETE CASCADE,
      orden INTEGER NOT NULL DEFAULT 0,
      rol VARCHAR(60) NOT NULL,
      cuit VARCHAR(11),
      razon_social VARCHAR(250),
      id_contraparte INTEGER REFERENCES contrapartes(id) ON DELETE SET NULL,
      nro_planta VARCHAR(30),
      actividad VARCHAR(120),
      domicilio VARCHAR(250),
      localidad VARCHAR(120),
      provincia VARCHAR(120),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS liquidacion_items (
      id BIGSERIAL PRIMARY KEY,
      id_liquidacion INTEGER NOT NULL REFERENCES liquidaciones(id) ON DELETE CASCADE,
      orden INTEGER NOT NULL DEFAULT 0,
      codigo_producto VARCHAR(30),
      descripcion_producto VARCHAR(150),
      campana VARCHAR(30),
      grado VARCHAR(30),
      cosecha VARCHAR(30),
      procedencia VARCHAR(200),
      destino VARCHAR(200),
      coe_certificado VARCHAR(20),
      ctg VARCHAR(20),
      kilos_brutos NUMERIC(14,3),
      kilos_merma NUMERIC(14,3),
      kilos_netos NUMERIC(14,3),
      kilos_netos_acondicionados NUMERIC(14,3),
      kilos_liquidados NUMERIC(14,3),
      precio_tonelada NUMERIC(18,6),
      importe_bruto NUMERIC(18,4),
      importe_ajustes_calidad NUMERIC(18,4),
      importe_neto NUMERIC(18,4),
      calidad JSONB NOT NULL DEFAULT '{}'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS liquidacion_referencias (
      id BIGSERIAL PRIMARY KEY,
      id_liquidacion INTEGER NOT NULL REFERENCES liquidaciones(id) ON DELETE CASCADE,
      orden INTEGER NOT NULL DEFAULT 0,
      tipo VARCHAR(50) NOT NULL,
      numero VARCHAR(100) NOT NULL,
      fecha DATE,
      kilos NUMERIC(14,3),
      importe NUMERIC(18,4),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Inventario sin perdida de todos los campos escalares que entregue ARCA.
    -- Permite conservar futuras versiones del WS aunque aun no tengan columna tipada.
    CREATE TABLE IF NOT EXISTS liquidacion_campos_oficiales (
      id BIGSERIAL PRIMARY KEY,
      id_liquidacion INTEGER NOT NULL REFERENCES liquidaciones(id) ON DELETE CASCADE,
      ruta VARCHAR(500) NOT NULL,
      campo VARCHAR(150) NOT NULL,
      ocurrencia INTEGER NOT NULL DEFAULT 0,
      tipo_dato VARCHAR(20) NOT NULL DEFAULT 'TEXTO',
      valor_texto TEXT,
      valor_numero NUMERIC(24,8),
      valor_fecha TIMESTAMPTZ,
      valor_booleano BOOLEAN,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(id_liquidacion,ruta,ocurrencia)
    );

    CREATE INDEX IF NOT EXISTS idx_liq_primaria_coe ON liquidaciones_primarias(coe);
    CREATE INDEX IF NOT EXISTS idx_liq_secundaria_coe ON liquidaciones_secundarias(coe);
    CREATE INDEX IF NOT EXISTS idx_liq_conceptos_liq ON liquidacion_conceptos(id_liquidacion, orden, id);
    CREATE INDEX IF NOT EXISTS idx_liq_impuestos_liq ON liquidacion_impuestos(id_liquidacion, orden, id);
    CREATE INDEX IF NOT EXISTS idx_liq_relaciones_liq ON liquidacion_relaciones(id_liquidacion, tipo_relacion);
    CREATE INDEX IF NOT EXISTS idx_liq_participantes_cuit ON liquidacion_participantes(cuit,id_liquidacion);
    CREATE INDEX IF NOT EXISTS idx_liq_items_producto ON liquidacion_items(codigo_producto,id_liquidacion);
    CREATE INDEX IF NOT EXISTS idx_liq_items_certificado ON liquidacion_items(coe_certificado);
    CREATE INDEX IF NOT EXISTS idx_liq_items_ctg ON liquidacion_items(ctg);
    CREATE INDEX IF NOT EXISTS idx_liq_referencias_numero ON liquidacion_referencias(tipo,numero);
    CREATE INDEX IF NOT EXISTS idx_liq_campos_busqueda ON liquidacion_campos_oficiales(campo,id_liquidacion);
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

