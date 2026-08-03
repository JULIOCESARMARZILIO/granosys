const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pool } = require('../db');

const execFileAsync = promisify(execFile);
const ticketCache = new Map();
let ticketTableReady = false;
let syncTablesReady = false;

function ticketEncryptionKey(config) {
  return crypto.createHash('sha256')
    .update('granosys:arca-ticket:v1:')
    .update(config.key)
    .digest();
}

function encryptTicket(ticket, config) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ticketEncryptionKey(config), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(ticket), 'utf8'),
    cipher.final()
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function decryptTicket(value, config) {
  const payload = Buffer.from(value, 'base64');
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ticketEncryptionKey(config), iv);
  decipher.setAuthTag(authTag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
}

async function ensureTicketTable() {
  if (ticketTableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS arca_access_tickets (
      cache_key TEXT PRIMARY KEY,
      encrypted_ticket TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  ticketTableReady = true;
}

async function ensureSyncTables() {
  if (syncTablesReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS arca_sync_jobs (
      id UUID PRIMARY KEY,
      fuente VARCHAR(40) NOT NULL,
      desde DATE NOT NULL,
      estado VARCHAR(20) NOT NULL,
      total_importados INTEGER NOT NULL DEFAULT 0,
      total_revisados INTEGER NOT NULL DEFAULT 0,
      solicitado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS arca_official_documents (
      id BIGSERIAL PRIMARY KEY,
      fuente VARCHAR(40) NOT NULL,
      external_key VARCHAR(180) NOT NULL,
      document_date DATE,
      payload JSONB NOT NULL,
      payload_hash VARCHAR(64) NOT NULL,
      first_imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(fuente, external_key)
    );
    CREATE INDEX IF NOT EXISTS idx_arca_documents_date
      ON arca_official_documents(fuente, document_date DESC);
  `);
  syncTablesReady = true;
}

async function loadPersistedTicket(cacheKey, config) {
  try {
    await ensureTicketTable();
    const { rows } = await pool.query(
      'SELECT encrypted_ticket, expires_at FROM arca_access_tickets WHERE cache_key=$1 AND expires_at > NOW() + INTERVAL \'5 minutes\'',
      [cacheKey]
    );
    if (!rows[0]) return null;
    const ticket = decryptTicket(rows[0].encrypted_ticket, config);
    if (!ticket.token || !ticket.sign) return null;
    ticket.expiresAt = new Date(rows[0].expires_at).getTime();
    return ticket;
  } catch (error) {
    console.error('No se pudo recuperar el TA persistido de ARCA:', error.message);
    return null;
  }
}

async function savePersistedTicket(cacheKey, ticket, config) {
  try {
    await ensureTicketTable();
    await pool.query(`
      INSERT INTO arca_access_tickets (cache_key, encrypted_ticket, expires_at, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (cache_key) DO UPDATE SET
        encrypted_ticket=EXCLUDED.encrypted_ticket,
        expires_at=EXCLUDED.expires_at,
        updated_at=NOW()
    `, [cacheKey, encryptTicket(ticket, config), new Date(ticket.expiresAt)]);
  } catch (error) {
    console.error('No se pudo persistir el TA de ARCA:', error.message);
  }
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tag(xml, name) {
  const match = String(xml).match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'i'));
  return match ? decodeXml(match[1].trim()) : null;
}

function tags(xml, name) {
  const matches = [];
  const expression = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'gi');
  let match;
  while ((match = expression.exec(String(xml))) !== null) matches.push(decodeXml(match[1].trim()));
  return matches;
}

function readPem(name, base64Name) {
  const base64 = process.env[base64Name];
  if (base64) return Buffer.from(base64.trim(), 'base64').toString('utf8').trim();
  const value = process.env[name];
  return value ? value.replace(/\\n/g, '\n').trim() : null;
}

function getConfig() {
  const mode = String(process.env.ARCA_MODE || 'DISABLED').toUpperCase();
  const production = mode === 'PRODUCTION' || String(process.env.AFIP_PROD).toLowerCase() === 'true';
  const cuit = String(process.env.AFIP_CUIT || '').replace(/\D/g, '');
  const cert = readPem('AFIP_CERT', 'AFIP_CERT_B64');
  const key = readPem('AFIP_KEY', 'AFIP_KEY_B64');
  if (!cuit || !cert || !key) throw new Error('Faltan AFIP_CUIT, AFIP_CERT o AFIP_KEY.');
  return { mode, production, cuit, cert, key };
}

function validateCredentials(config) {
  const certificate = new crypto.X509Certificate(config.cert);
  const privateKey = crypto.createPrivateKey(config.key);
  const certPublic = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const keyPublic = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  if (!crypto.timingSafeEqual(certPublic, keyPublic)) {
    throw new Error('El certificado ARCA no corresponde a la clave privada.');
  }
  const now = new Date();
  if (now < new Date(certificate.validFrom) || now > new Date(certificate.validTo)) {
    throw new Error('El certificado ARCA estÃ¡ fuera de vigencia.');
  }
  return certificate;
}

async function signTra(tra, cert, key) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'granosys-wsaa-'));
  const traPath = path.join(dir, 'tra.xml');
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  const cmsPath = path.join(dir, 'tra.cms');
  try {
    fs.writeFileSync(traPath, tra, { mode: 0o600 });
    fs.writeFileSync(certPath, cert, { mode: 0o600 });
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    await execFileAsync('openssl', [
      'smime', '-sign', '-signer', certPath, '-inkey', keyPath,
      '-in', traPath, '-out', cmsPath, '-outform', 'DER',
      '-nodetach', '-binary'
    ], { timeout: 15000, windowsHide: true });
    return fs.readFileSync(cmsPath).toString('base64');
  } catch (error) {
    throw new Error(`No se pudo firmar la solicitud WSAA con OpenSSL: ${error.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function soapPost(url, action, body) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'text/xml; charset=utf-8',
        SOAPAction: action
      },
      body,
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    const detail = error.cause?.code || error.cause?.message || error.message;
    const transportError = new Error(`No se pudo conectar con ${new URL(url).hostname}: ${detail}`);
    transportError.code = 'ARCA_TRANSPORT_ERROR';
    transportError.cause = error;
    throw transportError;
  }
  const xml = await response.text();
  if (!response.ok || /<(?:\w+:)?Fault\b/i.test(xml)) {
    throw new Error(tag(xml, 'faultstring') || tag(xml, 'faultcode') || `ARCA respondiÃ³ HTTP ${response.status}.`);
  }
  return xml;
}

async function getTicket(service = 'wslpg', force = false) {
  const config = getConfig();
  validateCredentials(config);
  const cacheKey = `${config.production}:${config.cuit}:${service}`;
  const cached = ticketCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) return cached;
  if (!force) {
    const persisted = await loadPersistedTicket(cacheKey, config);
    if (persisted) {
      ticketCache.set(cacheKey, persisted);
      return persisted;
    }
  }

  const now = Date.now();
  const generationTime = new Date(now - 10 * 60 * 1000).toISOString();
  const expirationTime = new Date(now + 11 * 60 * 60 * 1000).toISOString();
  const uniqueId = Math.floor(now / 1000);
  const tra = `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${uniqueId}</uniqueId><generationTime>${generationTime}</generationTime><expirationTime>${expirationTime}</expirationTime></header><service>${xmlEscape(service)}</service></loginTicketRequest>`;
  const cms = await signTra(tra, config.cert, config.key);
  const wsaaUrl = config.production
    ? 'https://wsaa.afip.gov.ar/ws/services/LoginCms'
    : 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms';
  const envelope = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${xmlEscape(cms)}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`;
  const response = await soapPost(wsaaUrl, '', envelope);
  const loginXml = tag(response, 'loginCmsReturn');
  const token = tag(loginXml, 'token');
  const sign = tag(loginXml, 'sign');
  const expires = Date.parse(tag(loginXml, 'expirationTime'));
  if (!token || !sign) throw new Error('WSAA no devolviÃ³ token y firma.');
  const ticket = { token, sign, expiresAt: Number.isFinite(expires) ? expires : now + 10 * 60 * 60 * 1000 };
  ticketCache.set(cacheKey, ticket);
  await savePersistedTicket(cacheKey, ticket, config);
  return ticket;
}

async function wslpgDummy() {
  const config = getConfig();
  const ticket = await getTicket('wslpg');
  const endpoints = config.production
    ? [
      {
        url: 'https://serviciosjava.arca.gob.ar/wslpg/LpgService',
        namespace: 'http://serviciosjava.arca.gob.ar/wslpg/'
      },
      {
        url: 'https://serviciosjava.afip.gob.ar/wslpg/LpgService',
        namespace: 'http://serviciosjava.afip.gob.ar/wslpg/'
      }
    ]
    : [{
      url: 'https://fwshomo.afip.gov.ar/wslpg/LpgService',
      namespace: 'http://serviciosjava.afip.gob.ar/wslpg/'
    }];

  let response;
  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index];
    // Consulta de catÃ¡logo explÃ­citamente de solo lectura. Se usa en lugar de
    // Dummy porque el endpoint productivo exige autenticaciÃ³n para esa llamada
    // aunque el ejemplo del manual 1.24 muestre un Body vacÃ­o.
    const envelope = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:lpg="${endpoint.namespace}"><soapenv:Header/><soapenv:Body><lpg:campaniaReq><auth><token>${xmlEscape(ticket.token)}</token><sign>${xmlEscape(ticket.sign)}</sign><cuit>${config.cuit}</cuit></auth></lpg:campaniaReq></soapenv:Body></soapenv:Envelope>`;
    try {
      response = await soapPost(endpoint.url, '', envelope);
      break;
    } catch (error) {
      const hasFallback = index < endpoints.length - 1;
      if (error.code !== 'ARCA_TRANSPORT_ERROR' || !hasFallback) throw error;
      console.warn(`WSLPG no accesible en ${new URL(endpoint.url).hostname}; se intenta el host alternativo oficial.`);
    }
  }
  const campaniaReturn = tag(response, 'campaniaReturn');
  if (!campaniaReturn) {
    throw new Error('WSLPG no devolviÃ³ la respuesta esperada para campaniasConsultar.');
  }
  return {
    estado: 'OK',
    consulta: 'campaniasConsultar',
    primeraCampania: {
      codigo: tag(campaniaReturn, 'codigo'),
      descripcion: tag(campaniaReturn, 'descripcion')
    }
  };
}

async function diagnosticarWslpg() {
  const config = getConfig();
  const certificate = validateCredentials(config);
  // Valida por separado que el certificado estÃ© autorizado para WSLPG.
  await getTicket('wslpg');
  const dummy = await wslpgDummy();
  return {
    modo: config.production ? 'PRODUCTION' : 'HOMOLOGATION',
    cuit: config.cuit,
    certificado: {
      fingerprint256: certificate.fingerprint256,
      validoDesde: certificate.validFrom,
      validoHasta: certificate.validTo
    },
    wsaa: 'OK',
    wslpg: dummy
  };
}

async function diagnosticarAutorizaciones() {
  const config = getConfig();
  validateCredentials(config);
  const servicios = ['wsfe', 'wscdc', 'wscpe', 'wslpg', 'ws_sr_padron_a13'];
  const resultados = await Promise.all(servicios.map(async (servicio) => {
    try {
      const ticket = await getTicket(servicio);
      return {
        servicio,
        autorizado: true,
        ticketValidoHasta: new Date(ticket.expiresAt).toISOString()
      };
    } catch (error) {
      return {
        servicio,
        autorizado: false,
        error: error.message
      };
    }
  }));

  return {
    modo: config.production ? 'PRODUCTION' : 'HOMOLOGATION',
    cuit: config.cuit,
    soloConsulta: true,
    resultados
  };
}

function fechaWsfe(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length !== 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

async function guardarDocumentoOficial(fuente, externalKey, documentDate, payload) {
  const serialized = JSON.stringify(payload);
  const hash = crypto.createHash('sha256').update(serialized).digest('hex');
  const { rowCount } = await pool.query(`
    INSERT INTO arca_official_documents
      (fuente, external_key, document_date, payload, payload_hash)
    VALUES ($1,$2,$3,$4::jsonb,$5)
    ON CONFLICT(fuente, external_key) DO UPDATE SET
      document_date=EXCLUDED.document_date,
      payload=EXCLUDED.payload,
      payload_hash=EXCLUDED.payload_hash,
      last_seen_at=NOW()
  `, [fuente, externalKey, documentDate, serialized, hash]);
  return rowCount > 0;
}

async function wsfeCall(method, requestXml = '') {
  const config = getConfig();
  const ticket = await getTicket('wsfe');
  const url = config.production
    ? 'https://servicios1.afip.gov.ar/wsfev1/service.asmx'
    : 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx';
  const auth = `<ar:Auth><ar:Token>${xmlEscape(ticket.token)}</ar:Token><ar:Sign>${xmlEscape(ticket.sign)}</ar:Sign><ar:Cuit>${config.cuit}</ar:Cuit></ar:Auth>`;
  const envelope = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/"><soapenv:Header/><soapenv:Body><ar:${method}>${auth}${requestXml}</ar:${method}></soapenv:Body></soapenv:Envelope>`;
  return soapPost(url, `http://ar.gov.afip.dif.FEV1/${method}`, envelope);
}

async function wsfePuntosVenta() {
  const xml = await wsfeCall('FEParamGetPtosVenta');
  return tags(xml, 'PtoVenta').map(item => ({ Nro: Number(tag(item, 'Nro')) }))
    .filter(item => Number.isInteger(item.Nro) && item.Nro > 0);
}

async function wsfeTiposComprobante() {
  const xml = await wsfeCall('FEParamGetTiposCbte');
  return tags(xml, 'CbteTipo').map(item => ({ Id: Number(tag(item, 'Id')) }))
    .filter(item => Number.isInteger(item.Id) && item.Id > 0);
}

async function wsfeUltimoComprobante(ptoVta, cbteTipo) {
  const xml = await wsfeCall(
    'FECompUltimoAutorizado',
    `<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`
  );
  return Number(tag(xml, 'CbteNro') || 0);
}

async function wsfeConsultarComprobante(numero, ptoVta, cbteTipo) {
  const xml = await wsfeCall(
    'FECompConsultar',
    `<ar:FeCompConsReq><ar:CbteTipo>${cbteTipo}</ar:CbteTipo><ar:CbteNro>${numero}</ar:CbteNro><ar:PtoVta>${ptoVta}</ar:PtoVta></ar:FeCompConsReq>`
  );
  const result = tag(xml, 'ResultGet');
  if (!result) throw new Error(tag(xml, 'Msg') || 'WSFE no devolviÃ³ ResultGet.');
  return {
    CbteFch: tag(result, 'CbteFch'),
    CbteTipo: Number(tag(result, 'CbteTipo') || cbteTipo),
    PtoVta: Number(tag(result, 'PtoVta') || ptoVta),
    CbteDesde: Number(tag(result, 'CbteDesde') || numero),
    DocTipo: Number(tag(result, 'DocTipo') || 0),
    DocNro: tag(result, 'DocNro'),
    ImpTotal: tag(result, 'ImpTotal'),
    MonId: tag(result, 'MonId'),
    MonCotiz: tag(result, 'MonCotiz'),
    CodAutorizacion: tag(result, 'CodAutorizacion'),
    EmisionTipo: tag(result, 'EmisionTipo'),
    FchVto: tag(result, 'FchVto'),
    rawXml: result
  };
}

async function ejecutarSyncFacturasEmitidas(jobId, desde, limite) {
  await ensureSyncTables();
  await pool.query(
    "UPDATE arca_sync_jobs SET estado='EJECUTANDO', started_at=NOW() WHERE id=$1",
    [jobId]
  );

  let revisados = 0;
  let importados = 0;
  try {
    const config = getConfig();
    validateCredentials(config);
    const puntos = await wsfePuntosVenta();
    const tipos = await wsfeTiposComprobante();

    outer:
    for (const punto of puntos || []) {
      const ptoVta = Number(punto.Nro ?? punto.nro ?? punto.Id ?? punto.id);
      if (!Number.isInteger(ptoVta) || ptoVta <= 0) continue;
      for (const tipo of tipos || []) {
        const cbteTipo = Number(tipo.Id ?? tipo.id);
        if (!Number.isInteger(cbteTipo) || cbteTipo <= 0) continue;
        let ultimo;
        try {
          ultimo = Number(await wsfeUltimoComprobante(ptoVta, cbteTipo));
        } catch {
          continue;
        }
        if (!Number.isInteger(ultimo) || ultimo <= 0) continue;

        for (let numero = ultimo; numero >= 1; numero -= 1) {
          if (revisados >= limite) break outer;
          revisados += 1;
          let comprobante;
          try {
            comprobante = await wsfeConsultarComprobante(numero, ptoVta, cbteTipo);
          } catch {
            continue;
          }
          const fecha = fechaWsfe(comprobante?.CbteFch);
          if (fecha && fecha < desde) break;
          if (!fecha || fecha < desde) continue;
          await guardarDocumentoOficial(
            'WSFE_EMITIDA',
            `${ptoVta}:${cbteTipo}:${numero}`,
            fecha,
            comprobante
          );
          importados += 1;
        }
      }
    }

    const estado = revisados >= limite ? 'PARCIAL' : 'COMPLETADO';
    await pool.query(`
      UPDATE arca_sync_jobs
      SET estado=$1, total_importados=$2, total_revisados=$3, finished_at=NOW()
      WHERE id=$4
    `, [estado, importados, revisados, jobId]);
  } catch (error) {
    await pool.query(`
      UPDATE arca_sync_jobs
      SET estado='ERROR', total_importados=$1, total_revisados=$2,
          error=$3, finished_at=NOW()
      WHERE id=$4
    `, [importados, revisados, error.message, jobId]);
  }
}

async function iniciarSyncFacturasEmitidas({ desde = '2026-01-01', limite = 1000, userId = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) throw new Error('La fecha desde debe usar formato AAAA-MM-DD.');
  const safeLimit = Math.max(1, Math.min(5000, Number(limite) || 1000));
  await ensureSyncTables();
  const id = crypto.randomUUID();
  await pool.query(`
    INSERT INTO arca_sync_jobs(id, fuente, desde, estado, solicitado_por)
    VALUES($1,'WSFE_EMITIDA',$2,'PENDIENTE',$3)
  `, [id, desde, userId]);
  setImmediate(() => {
    void ejecutarSyncFacturasEmitidas(id, desde, safeLimit);
  });
  return { id, fuente: 'WSFE_EMITIDA', desde, limite: safeLimit, estado: 'PENDIENTE' };
}

async function obtenerSyncJob(id) {
  await ensureSyncTables();
  const { rows } = await pool.query(
    'SELECT * FROM arca_sync_jobs WHERE id=$1',
    [id]
  );
  return rows[0] || null;
}

function diagnosticarCredenciales() {
  const config = getConfig();
  const certificate = validateCredentials(config);
  return {
    modo: config.production ? 'PRODUCTION' : 'HOMOLOGATION',
    cuitConfigurada: config.cuit,
    certificado: {
      subject: certificate.subject,
      issuer: certificate.issuer,
      serialNumber: certificate.serialNumber,
      fingerprint256: certificate.fingerprint256,
      validoDesde: certificate.validFrom,
      validoHasta: certificate.validTo,
      coincideConClavePrivada: true
    }
  };
}

module.exports = {
  getTicket,
  wslpgDummy,
  diagnosticarWslpg,
  diagnosticarAutorizaciones,
  iniciarSyncFacturasEmitidas,
  obtenerSyncJob,
  diagnosticarCredenciales,
  _internal: { xmlEscape, decodeXml, tag, getConfig, validateCredentials }
};
