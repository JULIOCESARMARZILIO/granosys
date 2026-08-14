const { pool } = require('../db');

const KG_KEYS = new Set([
  'kilosnetos', 'kgnetos', 'pesoneto', 'pesonetokg', 'pesonetototal',
  'pesonetototalcertificado', 'cantidadkg', 'kilogramos'
]);

function normalizeKey(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function collect(node, result = { values: [], byKey: new Map() }) {
  if (node === null || node === undefined) return result;
  if (Array.isArray(node)) {
    node.forEach(item => collect(item, result));
    return result;
  }
  if (typeof node !== 'object') {
    result.values.push(node);
    return result;
  }
  for (const [key, value] of Object.entries(node)) {
    const normalized = normalizeKey(key);
    if (!result.byKey.has(normalized)) result.byKey.set(normalized, []);
    if (value !== null && typeof value !== 'object') result.byKey.get(normalized).push(value);
    collect(value, result);
  }
  return result;
}

function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function extractKg(payload) {
  const data = collect(payload);
  for (const key of KG_KEYS) {
    for (const value of data.byKey.get(key) || []) {
      const kg = numeric(value);
      if (kg !== null && kg > 0) return kg;
    }
  }
  return null;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const left = new Date(a);
  const right = new Date(b);
  if (Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) return null;
  return Math.abs(left.getTime() - right.getTime()) / 86400000;
}

function kgTolerance(targetKg, configured = 0.01) {
  return Math.max(50, Number(targetKg || 0) * configured);
}

function findKgCombination(candidates, targetKg, tolerance = kgTolerance(targetKg)) {
  if (!targetKg || !candidates.length) return null;
  const usable = candidates.filter(item => item.kg > 0).slice(0, 60);
  let states = [{ sum: 0, items: [] }];
  let best = null;
  for (const candidate of usable) {
    const additions = states.map(state => ({ sum: state.sum + candidate.kg, items: [...state.items, candidate] }));
    states = [...states, ...additions]
      .filter(state => state.sum <= targetKg + tolerance && state.items.length <= 20)
      .sort((a, b) => Math.abs(targetKg - a.sum) - Math.abs(targetKg - b.sum))
      .slice(0, 600);
    const current = states[0];
    if (current && (!best || Math.abs(targetKg - current.sum) < Math.abs(targetKg - best.sum))) best = current;
    if (best && Math.abs(targetKg - best.sum) <= tolerance) break;
  }
  return best && Math.abs(targetKg - best.sum) <= tolerance ? best : null;
}

function containsValue(payload, expected) {
  const needle = normalizeKey(expected);
  if (!needle) return false;
  return collect(payload).values.some(value => normalizeKey(value) === needle || normalizeKey(value).includes(needle));
}

function baseEvidence(certificate, cpe) {
  const participantCuits = (cpe.participant_cuits || []).map(digits);
  const producerCuit = digits(certificate.cuit_productor);
  const cuitMatch = Boolean(producerCuit && participantCuits.includes(producerCuit));
  const speciesMatch = Boolean(certificate.especie_nombre && containsValue(cpe.payload, certificate.especie_nombre));
  const campaignMatch = Boolean(certificate.campana_desc && containsValue(cpe.payload, certificate.campana_desc));
  const dateDays = daysBetween(certificate.fecha_emision, cpe.document_date);
  let score = 0;
  if (cuitMatch) score += 35;
  if (speciesMatch) score += 20;
  if (campaignMatch) score += 10;
  if (dateDays !== null) score += dateDays <= 3 ? 15 : dateDays <= 15 ? 8 : dateDays <= 45 ? 3 : 0;
  return { score, cuitMatch, speciesMatch, campaignMatch, dateDays };
}

async function ensureTraceTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS arca_trace_links (
      id BIGSERIAL PRIMARY KEY,
      link_key VARCHAR(220) NOT NULL UNIQUE,
      link_type VARCHAR(40) NOT NULL,
      certificate_id INTEGER NOT NULL REFERENCES certificados_1116(id) ON DELETE CASCADE,
      cpe_document_id BIGINT REFERENCES arca_official_documents(id) ON DELETE CASCADE,
      liquidation_document_id BIGINT REFERENCES arca_official_documents(id) ON DELETE CASCADE,
      ctg VARCHAR(20),
      method VARCHAR(40) NOT NULL,
      score INTEGER NOT NULL,
      certificate_kg NUMERIC(14,3),
      linked_kg NUMERIC(14,3),
      kg_difference NUMERIC(14,3),
      status VARCHAR(30) NOT NULL CHECK (status IN ('PROPUESTO','CONFIRMADO_AUTOMATICO','CONFIRMADO','RECHAZADO')),
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      reviewed_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_arca_trace_certificate ON arca_trace_links(certificate_id, status);
    CREATE INDEX IF NOT EXISTS idx_arca_trace_cpe ON arca_trace_links(cpe_document_id);
    CREATE INDEX IF NOT EXISTS idx_arca_trace_liquidation ON arca_trace_links(liquidation_document_id);
  `);
}

async function upsertLink(link) {
  await pool.query(`
    INSERT INTO arca_trace_links
      (link_key,link_type,certificate_id,cpe_document_id,liquidation_document_id,ctg,method,score,
       certificate_kg,linked_kg,kg_difference,status,evidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
    ON CONFLICT(link_key) DO UPDATE SET
      method=EXCLUDED.method, score=EXCLUDED.score, certificate_kg=EXCLUDED.certificate_kg,
      linked_kg=EXCLUDED.linked_kg, kg_difference=EXCLUDED.kg_difference,
      evidence=EXCLUDED.evidence, updated_at=NOW(),
      status=CASE WHEN arca_trace_links.status IN ('CONFIRMADO','RECHAZADO') THEN arca_trace_links.status ELSE EXCLUDED.status END
  `, [link.key, link.type, link.certificateId, link.cpeDocumentId || null, link.liquidationDocumentId || null,
    link.ctg || null, link.method, link.score, link.certificateKg || null, link.linkedKg || null,
    link.kgDifference ?? null, link.status, JSON.stringify(link.evidence || {})]);
}

async function generateTraceProposals() {
  await ensureTraceTables();
  const { rows: certificates } = await pool.query(`
    SELECT c.*, e.nombre especie_nombre, ca.descripcion campana_desc,
      COALESCE(array_agg(cc.nro_ctg) FILTER (WHERE cc.nro_ctg IS NOT NULL), '{}') explicit_ctgs
    FROM certificados_1116 c
    LEFT JOIN especies e ON e.id=c.id_especie
    LEFT JOIN campanas ca ON ca.id=c.id_campana
    LEFT JOIN certificado_1116_ctgs cc ON cc.id_certificado_1116=c.id
    GROUP BY c.id,e.nombre,ca.descripcion
  `);
  const { rows: cpes } = await pool.query(`
    SELECT d.id document_id,d.document_date,d.payload,r.ctg,
      COALESCE(array_agg(DISTINCT p.cuit) FILTER (WHERE p.cuit IS NOT NULL), '{}') participant_cuits
    FROM arca_cpe_registry r
    JOIN arca_official_documents d ON d.id=r.document_id
    LEFT JOIN arca_cpe_participants p ON p.document_id=d.id
    GROUP BY d.id,r.ctg
  `);
  const { rows: liquidations } = await pool.query(`
    SELECT id, fuente, external_key, document_date, payload
    FROM arca_official_documents
    WHERE fuente LIKE 'WSLPG_%'
  `);
  let created = 0;
  for (const certificate of certificates) {
    const certificateKg = numeric(certificate.kilos_netos);
    const explicit = new Set((certificate.explicit_ctgs || []).map(digits));
    if (explicit.size) {
      for (const cpe of cpes.filter(item => explicit.has(digits(item.ctg)))) {
        await upsertLink({ key: `CPE:${certificate.id}:${cpe.document_id}`, type: 'CERTIFICADO_CPE',
          certificateId: certificate.id, cpeDocumentId: cpe.document_id, ctg: cpe.ctg, method: 'CTG_EXACTO',
          score: 100, certificateKg, linkedKg: extractKg(cpe.payload), status: 'CONFIRMADO_AUTOMATICO',
          evidence: { ctgExacto: true } });
        created += 1;
      }
    } else if (certificateKg) {
      const candidates = cpes.map(cpe => ({ ...cpe, kg: extractKg(cpe.payload), evidence: baseEvidence(certificate, cpe) }))
        .filter(item => item.kg && item.evidence.score >= 20 && (item.evidence.dateDays === null || item.evidence.dateDays <= 45))
        .sort((a, b) => b.evidence.score - a.evidence.score);
      const combination = findKgCombination(candidates, certificateKg);
      if (combination) {
        const difference = combination.sum - certificateKg;
        for (const cpe of combination.items) {
          await upsertLink({ key: `CPE:${certificate.id}:${cpe.document_id}`, type: 'CERTIFICADO_CPE',
            certificateId: certificate.id, cpeDocumentId: cpe.document_id, ctg: cpe.ctg,
            method: 'KILOS_CUIT_ESPECIE_FECHA', score: Math.min(95, cpe.evidence.score + 30),
            certificateKg, linkedKg: combination.sum, kgDifference: difference, status: 'PROPUESTO',
            evidence: { ...cpe.evidence, cpeKg: cpe.kg, groupCtgs: combination.items.map(item => item.ctg), groupKg: combination.sum } });
          created += 1;
        }
      }
    }
    const references = [certificate.coe, certificate.numero_certificado].filter(Boolean).map(digits);
    for (const liquidation of liquidations) {
      const values = collect(liquidation.payload).values.map(digits);
      if (references.some(ref => ref && values.includes(ref))) {
        await upsertLink({ key: `LIQ:${certificate.id}:${liquidation.id}`, type: 'CERTIFICADO_LIQUIDACION',
          certificateId: certificate.id, liquidationDocumentId: liquidation.id, method: 'REFERENCIA_OFICIAL_EXACTA',
          score: 100, certificateKg, status: 'CONFIRMADO_AUTOMATICO',
          evidence: { certificateReferences: references, liquidationSource: liquidation.fuente, externalKey: liquidation.external_key } });
        created += 1;
      }
    }
  }
  const { rows: summary } = await pool.query(`
    SELECT link_type,status,COUNT(*)::integer total FROM arca_trace_links GROUP BY link_type,status ORDER BY link_type,status
  `);
  return { processedCertificates: certificates.length, evaluatedCpes: cpes.length, evaluatedLiquidations: liquidations.length, upserts: created, summary };
}

async function listTraceLinks(certificateId = null) {
  await ensureTraceTables();
  const params = certificateId ? [certificateId] : [];
  const where = certificateId ? 'WHERE l.certificate_id=$1' : '';
  const { rows } = await pool.query(`
    SELECT l.*, c.coe certificate_coe,c.numero_certificado,c.tipo_formulario,c.nombre_productor,
      cd.external_key cpe_external_key,ld.external_key liquidation_external_key,ld.fuente liquidation_source
    FROM arca_trace_links l
    JOIN certificados_1116 c ON c.id=l.certificate_id
    LEFT JOIN arca_official_documents cd ON cd.id=l.cpe_document_id
    LEFT JOIN arca_official_documents ld ON ld.id=l.liquidation_document_id
    ${where}
    ORDER BY c.fecha_emision DESC NULLS LAST,l.score DESC,l.id
  `, params);
  return rows;
}

async function reviewTraceLink(id, status, userId) {
  if (!['CONFIRMADO', 'RECHAZADO'].includes(status)) throw new Error('Estado de revisiÃ³n invÃ¡lido.');
  await ensureTraceTables();
  const { rows } = await pool.query(`
    UPDATE arca_trace_links SET status=$2,reviewed_by=$3,reviewed_at=NOW(),updated_at=NOW()
    WHERE id=$1 RETURNING *
  `, [id, status, userId || null]);
  if (!rows[0]) throw new Error('VÃ­nculo no encontrado.');
  return rows[0];
}

module.exports = { extractKg, findKgCombination, baseEvidence, generateTraceProposals, listTraceLinks, reviewTraceLink };

