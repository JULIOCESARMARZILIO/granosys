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
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
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
    observations
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
    CREATE UNIQUE INDEX IF NOT EXISTS uq_certificados_1116_coe
      ON certificados_1116(coe) WHERE coe IS NOT NULL AND coe <> '';
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
  }
  return { state: extracted.observations.length ? 'OBSERVADO' : 'COMPLETO', certificateId, extracted };
}

async function extractAllCertificates({ limit = 1000 } = {}) {
  await ensureSchema();
  const { rows: documents } = await pool.query(`
    SELECT d.id,d.fuente,d.external_key,d.document_date,d.payload,
      EXISTS(SELECT 1 FROM arca_official_files f WHERE f.document_id=d.id AND f.file_type='PDF') has_pdf
    FROM arca_official_documents d
    WHERE d.fuente LIKE 'WSLPG_%'
      AND (d.fuente ILIKE '%CERT%' OR d.payload::text ILIKE '%certific%deposit%')
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

module.exports = { extractCertificate, extractAllCertificates, ensureSchema };
