const crypto = require('crypto');
const { pool } = require('../db');

function key(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.')
    : /^-?\d{1,3}(?:\.\d{3})+$/.test(raw) ? raw.replace(/\./g, '') : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function indexPayload(node, out = new Map()) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    node.forEach(item => indexPayload(item, out));
    return out;
  }
  if (typeof node !== 'object') return out;
  for (const [name, value] of Object.entries(node)) {
    const normalized = key(name);
    if (!out.has(normalized)) out.set(normalized, []);
    if (value !== null && typeof value !== 'object') out.get(normalized).push(value);
    indexPayload(value, out);
  }
  return out;
}

function first(index, aliases) {
  for (const alias of aliases) {
    const value = (index.get(key(alias)) || []).find(item => String(item).trim() !== '');
    if (value !== undefined) return value;
  }
  return null;
}

function all(index, aliases) {
  const values = [];
  for (const alias of aliases) values.push(...(index.get(key(alias)) || []));
  return [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
}

function normalizeCtg(value) {
  const result = digits(value);
  return /^\d{8,20}$/.test(result) ? result : null;
}

const QUALITY_FIELDS = [
  ['HUMEDAD', ['humedad', 'porcentajeHumedad', 'humedadPct'], '%'],
  ['MATERIA_EXTRANA', ['materiaExtrana', 'materiasExtranas', 'materiaExtranaPct'], '%'],
  ['GRANOS_DANADOS', ['granosDanados', 'danados', 'granoDanadoPct'], '%'],
  ['GRANOS_QUEBRADOS', ['granosQuebrados', 'quebrados', 'quebradosPct'], '%'],
  ['ZARANDA', ['zaranda', 'zarandaPct', 'mermaZaranda'], '%'],
  ['PROTEINA', ['proteina', 'proteinaPct'], '%'],
  ['PESO_HECTOLITRICO', ['pesoHectolitrico', 'ph'], 'KG/HL'],
  ['GRANOS_VERDES', ['granosVerdes', 'verdes', 'granoVerdePct'], '%'],
  ['ACIDEZ', ['acidez', 'acidezPct'], '%'],
  ['CHAMICO', ['chamico'], 'UNIDAD'],
  ['INSECTOS', ['insectos', 'insectosVivos'], 'UNIDAD']
];

function extractQualities(payload) {
  const index = indexPayload(payload || {});
  return QUALITY_FIELDS.map(([parameter, aliases, unit]) => ({
    parameter,
    value: number(first(index, aliases)),
    unit
  })).filter(item => item.value !== null);
}

function extractCertificate(payload, document = {}) {
  const index = indexPayload(payload || {});
  const coe = digits(first(index, ['coe', 'numeroCoe', 'nroCoe', 'codigoOperacionElectronica']) || document.external_key);
  const certificateNumber = String(first(index, ['numeroCertificado', 'nroCertificado', 'certificadoDeposito', 'numeroCertificacion']) || '').trim() || null;
  const form = String(first(index, ['tipoFormulario', 'tipoCertificado', 'tipoCertificacion']) || 'A').toUpperCase();
  const producerCuit = digits(first(index, ['cuitProductor', 'cuitDepositante', 'cuitTitularGrano', 'cuitVendedor']));
  const buyerCuit = digits(first(index, ['cuitComprador', 'cuitCertificador', 'cuitEmisor', 'cuitDepositario']));
  const producerName = String(first(index, ['razonSocialProductor', 'nombreProductor', 'productor', 'depositante']) || '').trim() || null;
  const buyerName = String(first(index, ['razonSocialComprador', 'nombreComprador', 'comprador', 'certificador']) || '').trim() || null;
  const species = String(first(index, ['especie', 'descripcionEspecie', 'producto', 'grano']) || '').trim() || null;
  const campaign = String(first(index, ['campana', 'cosecha', 'campanaComercial']) || '').trim() || null;
  const grossKg = number(first(index, ['kilosBrutos', 'kgBrutos', 'pesoBrutoCertificado', 'totalKilosBrutos', 'pesoOriginal']));
  const conditionedKg = number(first(index, ['kilosNetosAcondicionados', 'kgNetosAcondicionados', 'pesoNetoAcondicionado', 'kilosNetos', 'pesoNetoCertificado']));
  const humidityLossKg = number(first(index, ['mermaHumedadKg', 'kilosMermaHumedad', 'mermaHumedad']));
  const qualityLossKg = number(first(index, ['mermaCalidadKg', 'kilosMermaCalidad', 'mermaCalidad']));
  const otherLossKg = number(first(index, ['otrasMermasKg', 'kilosOtrasMermas', 'otrasMermas']));
  const ctgs = all(index, ['ctg', 'nroCtg', 'numeroCtg', 'ctdg', 'nroCtdg', 'numeroCartaPorte'])
    .map(normalizeCtg).filter(Boolean);
  const dateValue = first(index, ['fechaEmision', 'fechaCertificado', 'fechaCertificacion']) || document.document_date || null;
  const date = dateValue ? new Date(dateValue) : null;
  const totalLossKg = grossKg !== null && conditionedKg !== null ? grossKg - conditionedKg : null;
  const explainedLossKg = [humidityLossKg, qualityLossKg, otherLossKg].some(value => value !== null)
    ? [humidityLossKg, qualityLossKg, otherLossKg].reduce((sum, value) => sum + (value || 0), 0)
    : null;
  const observations = [];
  if (!coe || !/^\d{8,20}$/.test(coe)) observations.push('COE_FALTANTE_O_INVALIDO');
  if (!producerCuit || !/^\d{11}$/.test(producerCuit)) observations.push('PRODUCTOR_SIN_CUIT');
  if (!buyerCuit || !/^\d{11}$/.test(buyerCuit)) observations.push('COMPRADOR_CERTIFICADOR_SIN_CUIT');
  if (!ctgs.length) observations.push('SIN_CTG');
  if (grossKg === null) observations.push('SIN_KILOS_BRUTOS');
  if (conditionedKg === null) observations.push('SIN_KILOS_NETOS_ACONDICIONADOS');
  if (totalLossKg !== null && totalLossKg < -0.001) observations.push('NETO_ACONDICIONADO_MAYOR_QUE_BRUTO');
  if (totalLossKg !== null && explainedLossKg !== null && Math.abs(totalLossKg - explainedLossKg) > 1)
    observations.push('MERMAS_NO_RECONCILIAN');

  return {
    coe, certificateNumber, form: ['A', 'B', 'C'].includes(form) ? form : 'A',
    producerCuit: /^\d{11}$/.test(producerCuit) ? producerCuit : null,
    buyerCuit: /^\d{11}$/.test(buyerCuit) ? buyerCuit : null,
    producerName, buyerName, species, campaign, grossKg, conditionedKg,
    humidityLossKg, qualityLossKg, otherLossKg, totalLossKg, ctgs: [...new Set(ctgs)],
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    observations, qualities: extractQualities(payload)
  };
}

async function ensureSchema() {
  await pool.query(`
    ALTER TABLE certificados_1116 ADD COLUMN IF NOT EXISTS cuit_comprador_certificador VARCHAR(13);
    ALTER TABLE certificados_1116 ADD COLUMN IF NOT EXISTS nombre_comprador_certificador VARCHAR(200);
    ALTER TABLE certificados_1116 ADD COLUMN IF NOT EXISTS kilos_brutos_certificados NUMERIC(14,3);
    ALTER TABLE certificados_1116 ADD COLUMN IF NOT EXISTS kilos_netos_acondicionados NUMERIC(14,3);
    ALTER TABLE certificados_1116 ADD COLUMN IF NOT EXISTS merma_humedad_kg NUMERIC(14,3);
    ALTER TABLE certificados_1116 ADD COLUMN IF NOT EXISTS merma_calidad_kg NUMERIC(14,3);
    ALTER TABLE certificados_1116 ADD COLUMN IF NOT EXISTS otras_mermas_kg NUMERIC(14,3);
    ALTER TABLE certificados_1116 ADD COLUMN IF NOT EXISTS estado_extraccion VARCHAR(30) DEFAULT 'PENDIENTE';
    ALTER TABLE certificados_1116 ADD COLUMN IF NOT EXISTS observaciones_extraccion JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE certificados_1116 ADD COLUMN IF NOT EXISTS arca_document_id BIGINT REFERENCES arca_official_documents(id) ON DELETE SET NULL;
    ALTER TABLE certificado_1116_ctgs ADD COLUMN IF NOT EXISTS cpe_document_id BIGINT REFERENCES arca_official_documents(id) ON DELETE SET NULL;
    ALTER TABLE certificado_1116_ctgs ADD COLUMN IF NOT EXISTS kg_brutos_aplicados NUMERIC(14,3);
    ALTER TABLE certificado_1116_ctgs ADD COLUMN IF NOT EXISTS merma_humedad_kg NUMERIC(14,3);
    ALTER TABLE certificado_1116_ctgs ADD COLUMN IF NOT EXISTS merma_calidad_kg NUMERIC(14,3);
    ALTER TABLE certificado_1116_ctgs ADD COLUMN IF NOT EXISTS otras_mermas_kg NUMERIC(14,3);
    ALTER TABLE certificado_1116_ctgs ADD COLUMN IF NOT EXISTS kg_netos_acondicionados NUMERIC(14,3);
    ALTER TABLE certificado_1116_ctgs ADD COLUMN IF NOT EXISTS origen_vinculacion VARCHAR(30);
    ALTER TABLE certificado_1116_ctgs ADD COLUMN IF NOT EXISTS estado_revision VARCHAR(20) DEFAULT 'PENDIENTE';
    CREATE TABLE IF NOT EXISTS certificado_1116_calidades (
      id BIGSERIAL PRIMARY KEY,
      id_certificado_1116 INTEGER NOT NULL REFERENCES certificados_1116(id) ON DELETE CASCADE,
      parametro VARCHAR(60) NOT NULL,
      valor NUMERIC(14,4) NOT NULL,
      unidad VARCHAR(20),
      origen VARCHAR(30) NOT NULL DEFAULT 'CERTIFICADO_ARCA',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(id_certificado_1116,parametro)
    );
    CREATE TABLE IF NOT EXISTS cpe_calidades_certificado (
      id BIGSERIAL PRIMARY KEY,
      cpe_document_id BIGINT NOT NULL REFERENCES arca_official_documents(id) ON DELETE CASCADE,
      id_certificado_1116 INTEGER NOT NULL REFERENCES certificados_1116(id) ON DELETE CASCADE,
      nro_ctg VARCHAR(30) NOT NULL,
      parametro VARCHAR(60) NOT NULL,
      valor NUMERIC(14,4) NOT NULL,
      unidad VARCHAR(20),
      heredada BOOLEAN NOT NULL DEFAULT TRUE,
      origen VARCHAR(30) NOT NULL DEFAULT 'CERTIFICADO_ARCA',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(cpe_document_id,id_certificado_1116,parametro)
    );
    CREATE INDEX IF NOT EXISTS idx_cpe_calidad_ctg ON cpe_calidades_certificado(nro_ctg);
    CREATE TABLE IF NOT EXISTS arca_certificate_rebuild_jobs (
      id UUID PRIMARY KEY,
      estado VARCHAR(20) NOT NULL CHECK (estado IN ('PENDIENTE','PROCESANDO','COMPLETADO','ERROR')),
      etapa VARCHAR(40) NOT NULL DEFAULT 'PENDIENTE',
      solicitado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      resultado JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_certificados_1116_coe
      ON certificados_1116(coe) WHERE coe IS NOT NULL AND coe <> '';
    CREATE TABLE IF NOT EXISTS certificado_1116_liquidaciones (
      id BIGSERIAL PRIMARY KEY,
      id_certificado_1116 INTEGER NOT NULL REFERENCES certificados_1116(id) ON DELETE CASCADE,
      arca_document_id BIGINT NOT NULL REFERENCES arca_official_documents(id) ON DELETE RESTRICT,
      coe_liquidacion VARCHAR(30),
      fecha_liquidacion DATE,
      kg_brutos_descargados NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (kg_brutos_descargados >= 0),
      kg_netos_acondicionados_descargados NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (kg_netos_acondicionados_descargados >= 0),
      datos_raw JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(id_certificado_1116, arca_document_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cert_liq_certificado
      ON certificado_1116_liquidaciones(id_certificado_1116, fecha_liquidacion, id);
  `);
}

async function resolveCatalog(client, table, name, value) {
  if (!value) return null;
  const { rows } = await client.query(`SELECT id FROM ${table} WHERE ${name} ILIKE $1 ORDER BY id LIMIT 1`, [value]);
  return rows[0]?.id || null;
}

async function processDocument(client, document) {
  const extracted = extractCertificate(document.payload, document);
  if (!extracted.coe) return { state: 'OBSERVADO', extracted };
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`CERT:${extracted.coe}`]);
  const speciesId = await resolveCatalog(client, 'especies', 'nombre', extracted.species);
  const campaignId = await resolveCatalog(client, 'campanas', 'descripcion', extracted.campaign);
  const existing = await client.query('SELECT id FROM certificados_1116 WHERE coe=$1 LIMIT 1', [extracted.coe]);
  let certificateId;
  if (existing.rows[0]) {
    certificateId = existing.rows[0].id;
    await client.query(`
      UPDATE certificados_1116 SET
        tipo_formulario=COALESCE($2,tipo_formulario), numero_certificado=COALESCE($3,numero_certificado),
        cuit_productor=COALESCE($4,cuit_productor), nombre_productor=COALESCE($5,nombre_productor),
        cuit_comprador_certificador=COALESCE($6,cuit_comprador_certificador),
        nombre_comprador_certificador=COALESCE($7,nombre_comprador_certificador),
        id_especie=COALESCE($8,id_especie), id_campana=COALESCE($9,id_campana),
        kilos_brutos_certificados=COALESCE($10,kilos_brutos_certificados),
        kilos_netos_acondicionados=COALESCE($11,kilos_netos_acondicionados),
        kilos_netos=COALESCE($11,kilos_netos), merma_humedad_kg=COALESCE($12,merma_humedad_kg),
        merma_calidad_kg=COALESCE($13,merma_calidad_kg), otras_mermas_kg=COALESCE($14,otras_mermas_kg),
        fecha_emision=COALESCE($15,fecha_emision), datos_raw=$16::jsonb, arca_document_id=$17,
        estado_extraccion=$18, observaciones_extraccion=$19::jsonb, origen_carga='INVENTARIO_ARCA'
      WHERE id=$1
    `, [certificateId, extracted.form, extracted.certificateNumber, extracted.producerCuit, extracted.producerName,
      extracted.buyerCuit, extracted.buyerName, speciesId, campaignId, extracted.grossKg, extracted.conditionedKg,
      extracted.humidityLossKg, extracted.qualityLossKg, extracted.otherLossKg, extracted.date,
      JSON.stringify(document.payload || {}), document.id, extracted.observations.length ? 'OBSERVADO' : 'COMPLETO',
      JSON.stringify(extracted.observations)]);
  } else {
    const { rows } = await client.query(`
      INSERT INTO certificados_1116
        (tipo_formulario,numero_certificado,coe,cuit_productor,nombre_productor,
         cuit_comprador_certificador,nombre_comprador_certificador,id_especie,id_campana,
         kilos_netos,kilos_brutos_certificados,kilos_netos_acondicionados,merma_humedad_kg,
         merma_calidad_kg,otras_mermas_kg,fecha_emision,origen_carga,datos_raw,arca_document_id,
         estado_extraccion,observaciones_extraccion)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,$12,$13,$14,$15,'INVENTARIO_ARCA',$16::jsonb,$17,$18,$19::jsonb)
      RETURNING id
    `, [extracted.form, extracted.certificateNumber, extracted.coe, extracted.producerCuit, extracted.producerName,
      extracted.buyerCuit, extracted.buyerName, speciesId, campaignId, extracted.conditionedKg, extracted.grossKg,
      extracted.humidityLossKg, extracted.qualityLossKg, extracted.otherLossKg, extracted.date,
      JSON.stringify(document.payload || {}), document.id, extracted.observations.length ? 'OBSERVADO' : 'COMPLETO',
      JSON.stringify(extracted.observations)]);
    certificateId = rows[0].id;
  }


  for (const quality of extracted.qualities) {
    await client.query(`
      INSERT INTO certificado_1116_calidades(id_certificado_1116,parametro,valor,unidad)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(id_certificado_1116,parametro) DO UPDATE SET
        valor=EXCLUDED.valor,unidad=EXCLUDED.unidad,updated_at=NOW()
    `, [certificateId, quality.parameter, quality.value, quality.unit]);
  }

  for (const ctg of extracted.ctgs) {
    const { rows: cpes } = await client.query(`
      SELECT r.document_id,m.id movimiento_id,m.peso_neto_llegada_kg,m.kg_liquidables,m.humedad_llegada_pct,
             CASE WHEN m.peso_neto_llegada_kg IS NOT NULL AND m.kg_liquidables IS NOT NULL
                  THEN m.peso_neto_llegada_kg-m.kg_liquidables END merma_total
      FROM arca_cpe_registry r
      LEFT JOIN movimientos m ON regexp_replace(COALESCE(m.nro_ctg,''),'[^0-9]','','g')=$1
      WHERE r.ctg=$1 LIMIT 1
    `, [ctg]);
    const cpe = cpes[0] || {};
    await client.query(`
      INSERT INTO certificado_1116_ctgs
        (id_certificado_1116,nro_ctg,id_movimiento,cpe_document_id,kg_brutos_aplicados,
         kg_netos_acondicionados,origen_vinculacion,estado_revision)
      VALUES($1,$2,$3,$4,$5,$6,'CTG_EXACTO','CONFIRMADO')
      ON CONFLICT(id_certificado_1116,nro_ctg) DO UPDATE SET
        id_movimiento=COALESCE(EXCLUDED.id_movimiento,certificado_1116_ctgs.id_movimiento),
        cpe_document_id=COALESCE(EXCLUDED.cpe_document_id,certificado_1116_ctgs.cpe_document_id),
        kg_brutos_aplicados=COALESCE(EXCLUDED.kg_brutos_aplicados,certificado_1116_ctgs.kg_brutos_aplicados),
        kg_netos_acondicionados=COALESCE(EXCLUDED.kg_netos_acondicionados,certificado_1116_ctgs.kg_netos_acondicionados),
        origen_vinculacion='CTG_EXACTO',estado_revision='CONFIRMADO'
    `, [certificateId, ctg, cpe.movimiento_id || null, cpe.document_id || null,
      number(cpe.peso_neto_llegada_kg), number(cpe.kg_liquidables)]);

    if (cpe.document_id) {
      for (const quality of extracted.qualities) {
        await client.query(`
          INSERT INTO cpe_calidades_certificado
            (cpe_document_id,id_certificado_1116,nro_ctg,parametro,valor,unidad)
          VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(cpe_document_id,id_certificado_1116,parametro) DO UPDATE SET
            nro_ctg=EXCLUDED.nro_ctg,valor=EXCLUDED.valor,unidad=EXCLUDED.unidad,
            heredada=TRUE,origen='CERTIFICADO_ARCA',updated_at=NOW()
        `, [cpe.document_id, certificateId, ctg, quality.parameter, quality.value, quality.unit]);
      }
    }
  }
  return { state: extracted.observations.length ? 'OBSERVADO' : 'COMPLETO', certificateId, extracted };
}

async function extractAllCertificates({ limit = 1000 } = {}) {
  await ensureSchema();
  const { rows: documents } = await pool.query(`
    SELECT d.id,d.fuente,d.external_key,d.document_date,d.payload,
      EXISTS(SELECT 1 FROM arca_official_files f WHERE f.document_id=d.id AND f.file_type='PDF') has_pdf
    FROM arca_official_documents d
    WHERE (
      d.fuente LIKE 'WSLPG_%'
      OR d.fuente = 'ARCA_CEG_INTERACTIVO'
    )
      AND (
        d.fuente ILIKE '%CERT%'
        OR d.fuente = 'ARCA_CEG_INTERACTIVO'
        OR d.payload::text ILIKE '%certific%deposit%'
      )
    ORDER BY d.document_date,d.id
    LIMIT $1
  `, [Math.max(1, Math.min(10000, Number(limit) || 1000))]);
  const summary = { documents: documents.length, complete: 0, observed: 0, errors: [], withPdf: 0 };
  for (const document of documents) {
    if (document.has_pdf) summary.withPdf += 1;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await processDocument(client, document);
      await client.query('COMMIT');
      result.state === 'COMPLETO' ? summary.complete += 1 : summary.observed += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      summary.errors.push({ documentId: document.id, externalKey: document.external_key, error: error.message });
    } finally {
      client.release();
    }
  }
  return summary;
}

function extractLiquidationApplication(payload, document = {}) {
  const index = indexPayload(payload || {});
  const certificateCoe = digits(first(index, [
    'coeCertificado', 'coeCertificadoDeposito', 'coeCertificacion', 'coeOrigen',
    'numeroCoeCertificado', 'nroCoeCertificado'
  ]));
  const liquidationCoe = digits(first(index, ['coe', 'coeLiquidacion', 'numeroCoe', 'nroCoe']) || document.external_key);
  const grossKg = number(first(index, [
    'kilosBrutosAplicados', 'kgBrutosAplicados', 'kilosBrutosLiquidacion',
    'kgBrutosLiquidacion', 'pesoBruto'
  ]));
  const conditionedKg = number(first(index, [
    'kilosNetosAcondicionadosAplicados', 'kgNetosAcondicionadosAplicados',
    'kilosNetosLiquidacion', 'kgNetosLiquidacion', 'pesoNetoAcondicionado',
    'kilosNetos', 'pesoNeto'
  ]));
  const dateValue = first(index, ['fechaLiquidacion', 'fechaEmision']) || document.document_date || null;
  const date = dateValue ? new Date(dateValue) : null;
  return {
    certificateCoe,
    liquidationCoe: liquidationCoe || null,
    grossKg,
    conditionedKg,
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    observations: [
      ...(!certificateCoe ? ['SIN_COE_CERTIFICADO_REFERENCIADO'] : []),
      ...(grossKg === null ? ['SIN_KILOS_BRUTOS_LIQUIDADOS'] : []),
      ...(conditionedKg === null ? ['SIN_KILOS_NETOS_ACONDICIONADOS_LIQUIDADOS'] : [])
    ]
  };
}

async function applyAllLiquidations({ limit = 5000 } = {}) {
  await ensureSchema();
  const { rows: documents } = await pool.query(`
    SELECT id,fuente,external_key,document_date,payload
    FROM arca_official_documents
    WHERE fuente LIKE 'WSLPG_%'
      AND fuente NOT ILIKE '%CERT%'
      AND (fuente ILIKE '%LPG%' OR fuente ILIKE '%LSG%' OR payload::text ILIKE '%liquidacion%')
    ORDER BY document_date,id
    LIMIT $1
  `, [Math.max(1, Math.min(20000, Number(limit) || 5000))]);
  const summary = { documents: documents.length, applied: 0, observed: 0, errors: [] };
  for (const document of documents) {
    const application = extractLiquidationApplication(document.payload, document);
    if (application.observations.length) {
      summary.observed += 1;
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: certificates } = await client.query(
        'SELECT id,kilos_brutos_certificados,kilos_netos_acondicionados FROM certificados_1116 WHERE coe=$1 FOR UPDATE',
        [application.certificateCoe]
      );
      if (!certificates[0]) {
        await client.query('ROLLBACK');
        summary.observed += 1;
        continue;
      }
      await client.query(`
        INSERT INTO certificado_1116_liquidaciones
          (id_certificado_1116,arca_document_id,coe_liquidacion,fecha_liquidacion,
           kg_brutos_descargados,kg_netos_acondicionados_descargados,datos_raw)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT(id_certificado_1116,arca_document_id) DO UPDATE SET
          coe_liquidacion=EXCLUDED.coe_liquidacion,
          fecha_liquidacion=EXCLUDED.fecha_liquidacion,
          kg_brutos_descargados=EXCLUDED.kg_brutos_descargados,
          kg_netos_acondicionados_descargados=EXCLUDED.kg_netos_acondicionados_descargados,
          datos_raw=EXCLUDED.datos_raw,updated_at=NOW()
      `, [certificates[0].id, document.id, application.liquidationCoe, application.date,
        application.grossKg, application.conditionedKg, JSON.stringify(document.payload || {})]);
      const { rows: balances } = await client.query(`
        SELECT
          c.kilos_brutos_certificados-COALESCE(SUM(a.kg_brutos_descargados),0) saldo_bruto,
          c.kilos_netos_acondicionados-COALESCE(SUM(a.kg_netos_acondicionados_descargados),0) saldo_neto
        FROM certificados_1116 c
        LEFT JOIN certificado_1116_liquidaciones a ON a.id_certificado_1116=c.id
        WHERE c.id=$1 GROUP BY c.id
      `, [certificates[0].id]);
      if ((number(balances[0]?.saldo_bruto) ?? 0) < -0.001 || (number(balances[0]?.saldo_neto) ?? 0) < -0.001)
        throw new Error('La liquidacion supera el saldo disponible del certificado.');
      await client.query('COMMIT');
      summary.applied += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      summary.errors.push({ documentId: document.id, externalKey: document.external_key, error: error.message });
    } finally {
      client.release();
    }
  }
  return summary;
}

async function listCertificateAccounts() {
  await ensureSchema();
  const { rows } = await pool.query(`
    SELECT c.id,c.coe,c.numero_certificado,c.fecha_emision,c.cuit_productor,c.nombre_productor,
      c.cuit_comprador_certificador,c.nombre_comprador_certificador,
      c.kilos_brutos_certificados,c.kilos_netos_acondicionados,
      COALESCE((SELECT SUM(a.kg_brutos_descargados) FROM certificado_1116_liquidaciones a
                WHERE a.id_certificado_1116=c.id),0) kg_brutos_liquidados,
      COALESCE((SELECT SUM(a.kg_netos_acondicionados_descargados) FROM certificado_1116_liquidaciones a
                WHERE a.id_certificado_1116=c.id),0) kg_netos_liquidados,
      c.kilos_brutos_certificados-COALESCE((SELECT SUM(a.kg_brutos_descargados)
        FROM certificado_1116_liquidaciones a WHERE a.id_certificado_1116=c.id),0) saldo_kg_brutos,
      c.kilos_netos_acondicionados-COALESCE((SELECT SUM(a.kg_netos_acondicionados_descargados)
        FROM certificado_1116_liquidaciones a WHERE a.id_certificado_1116=c.id),0) saldo_kg_netos_acondicionados,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'ctg',cc.nro_ctg,'cpe_document_id',cc.cpe_document_id,'movimiento_id',cc.id_movimiento,
        'kg_brutos',cc.kg_brutos_aplicados,'kg_netos_acondicionados',cc.kg_netos_acondicionados)
        ORDER BY cc.id) FROM certificado_1116_ctgs cc WHERE cc.id_certificado_1116=c.id),'[]'::jsonb) cpes,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'arca_document_id',a.arca_document_id,'coe_liquidacion',a.coe_liquidacion,
        'fecha',a.fecha_liquidacion,'kg_brutos',a.kg_brutos_descargados,
        'kg_netos_acondicionados',a.kg_netos_acondicionados_descargados)
        ORDER BY a.fecha_liquidacion,a.id) FROM certificado_1116_liquidaciones a
        WHERE a.id_certificado_1116=c.id),'[]'::jsonb) liquidaciones
    FROM certificados_1116 c
    ORDER BY c.fecha_emision DESC NULLS LAST,c.id DESC
  `);
  return rows;
}

async function assignExistingCpesAndQualities() {
  await ensureSchema();
  const updated = await pool.query(`
    UPDATE certificado_1116_ctgs cc SET
      cpe_document_id=r.document_id,
      id_movimiento=COALESCE(m.id,cc.id_movimiento),
      kg_brutos_aplicados=COALESCE(m.peso_neto_llegada_kg,cc.kg_brutos_aplicados),
      kg_netos_acondicionados=COALESCE(m.kg_liquidables,cc.kg_netos_acondicionados),
      origen_vinculacion='CTG_EXACTO',estado_revision='CONFIRMADO'
    FROM arca_cpe_registry r
    LEFT JOIN LATERAL (
      SELECT id,peso_neto_llegada_kg,kg_liquidables FROM movimientos
      WHERE regexp_replace(COALESCE(nro_ctg,''),'[^0-9]','','g')=r.ctg
      ORDER BY id LIMIT 1
    ) m ON TRUE
    WHERE regexp_replace(cc.nro_ctg,'[^0-9]','','g')=r.ctg
  `);
  await pool.query(`
    INSERT INTO cpe_calidades_certificado
      (cpe_document_id,id_certificado_1116,nro_ctg,parametro,valor,unidad)
    SELECT cc.cpe_document_id,cc.id_certificado_1116,cc.nro_ctg,q.parametro,q.valor,q.unidad
    FROM certificado_1116_ctgs cc
    JOIN certificado_1116_calidades q ON q.id_certificado_1116=cc.id_certificado_1116
    WHERE cc.cpe_document_id IS NOT NULL
    ON CONFLICT(cpe_document_id,id_certificado_1116,parametro) DO UPDATE SET
      nro_ctg=EXCLUDED.nro_ctg,valor=EXCLUDED.valor,unidad=EXCLUDED.unidad,
      heredada=TRUE,origen='CERTIFICADO_ARCA',updated_at=NOW()
  `);
  const { rows } = await pool.query(`
    SELECT COUNT(*)::integer total_ctg,
      COUNT(*) FILTER(WHERE cpe_document_id IS NOT NULL)::integer cpe_asignadas,
      COUNT(*) FILTER(WHERE cpe_document_id IS NULL)::integer cpe_pendientes,
      (SELECT COUNT(*)::integer FROM cpe_calidades_certificado) calidades_heredadas
    FROM certificado_1116_ctgs
  `);
  return { actualizadas: updated.rowCount, ...rows[0] };
}

async function runRebuildJob(id) {
  try {
    await pool.query("UPDATE arca_certificate_rebuild_jobs SET estado='PROCESANDO',etapa='EXTRAER_CERTIFICADOS',started_at=NOW() WHERE id=$1", [id]);
    const certificados = await extractAllCertificates({ limit: 10000 });
    await pool.query("UPDATE arca_certificate_rebuild_jobs SET etapa='ASIGNAR_CPE_Y_CALIDADES' WHERE id=$1", [id]);
    const cpes = await assignExistingCpesAndQualities();
    const resultado = { certificados, cpes };
    await pool.query("UPDATE arca_certificate_rebuild_jobs SET estado='COMPLETADO',etapa='FINALIZADO',resultado=$2::jsonb,finished_at=NOW() WHERE id=$1", [id, JSON.stringify(resultado)]);
  } catch (error) {
    await pool.query("UPDATE arca_certificate_rebuild_jobs SET estado='ERROR',error=$2,finished_at=NOW() WHERE id=$1", [id, error.message]);
  }
}

async function startRebuildJob(userId = null) {
  await ensureSchema();
  const { rows: active } = await pool.query("SELECT id,estado,etapa FROM arca_certificate_rebuild_jobs WHERE estado IN ('PENDIENTE','PROCESANDO') ORDER BY created_at DESC LIMIT 1");
  if (active[0]) return { ...active[0], alreadyRunning: true };
  const id = crypto.randomUUID();
  await pool.query("INSERT INTO arca_certificate_rebuild_jobs(id,estado,etapa,solicitado_por) VALUES($1,'PENDIENTE','PENDIENTE',$2)", [id, userId]);
  setImmediate(() => void runRebuildJob(id));
  return { id, estado:'PENDIENTE', etapa:'PENDIENTE', alreadyRunning:false };
}

async function getRebuildJob(id) {
  await ensureSchema();
  const { rows } = await pool.query("SELECT id,estado,etapa,resultado,error,created_at,started_at,finished_at FROM arca_certificate_rebuild_jobs WHERE id=$1", [id]);
  return rows[0] || null;
}

module.exports = { extractCertificate, extractLiquidationApplication, extractQualities, extractAllCertificates, assignExistingCpesAndQualities, applyAllLiquidations, listCertificateAccounts, startRebuildJob, getRebuildJob, ensureSchema };
