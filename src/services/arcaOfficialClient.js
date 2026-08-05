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
let reconciliationTableReady = false;

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

async function ensureReconciliationTable() {
  if (reconciliationTableReady) return;
  await ensureSyncTables();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS arca_cc_reconciliations (
      id BIGSERIAL PRIMARY KEY,
      document_id BIGINT NOT NULL UNIQUE REFERENCES arca_official_documents(id) ON DELETE RESTRICT,
      contraparte_id INTEGER NOT NULL REFERENCES contrapartes(id) ON DELETE RESTRICT,
      cc_movimiento_id INTEGER REFERENCES cc_contrapartes(id) ON DELETE RESTRICT,
      estado VARCHAR(20) NOT NULL CHECK (estado IN ('VINCULADO','CREADO','RECHAZADO')),
      decision VARCHAR(30) NOT NULL,
      importe NUMERIC(14,4) NOT NULL,
      payload_hash VARCHAR(64) NOT NULL,
      observacion VARCHAR(500),
      decidido_por INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
      decidido_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_arca_cc_reconciliation_estado
      ON arca_cc_reconciliations(estado, decidido_at DESC);
  `);
  reconciliationTableReady = true;
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

function numeroFiscal(value) {
  const number = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(number) ? number : 0;
}

function bloquesXml(xml, wrapper, item) {
  const container = tag(xml, wrapper);
  return container ? tags(container, item) : [];
}

function detalleFiscalWsfe(payload = {}) {
  const rawXml = payload.rawXml || '';
  const leer = name => payload[name] ?? tag(rawXml, name);
  const alicuotas = Array.isArray(payload.AlicIva)
    ? payload.AlicIva
    : bloquesXml(rawXml, 'Iva', 'AlicIva').map(item => ({
      Id: Number(tag(item, 'Id') || 0),
      BaseImp: numeroFiscal(tag(item, 'BaseImp')),
      Importe: numeroFiscal(tag(item, 'Importe'))
    }));
  const tributos = Array.isArray(payload.Tributos)
    ? payload.Tributos
    : bloquesXml(rawXml, 'Tributos', 'Tributo').map(item => ({
      Id: Number(tag(item, 'Id') || 0),
      Desc: tag(item, 'Desc') || '',
      BaseImp: numeroFiscal(tag(item, 'BaseImp')),
      Alic: numeroFiscal(tag(item, 'Alic')),
      Importe: numeroFiscal(tag(item, 'Importe'))
    }));
  return {
    ImpTotal: numeroFiscal(leer('ImpTotal')),
    ImpTotConc: numeroFiscal(leer('ImpTotConc')),
    ImpNeto: numeroFiscal(leer('ImpNeto')),
    ImpOpEx: numeroFiscal(leer('ImpOpEx')),
    ImpTrib: numeroFiscal(leer('ImpTrib')),
    ImpIVA: numeroFiscal(leer('ImpIVA')),
    AlicIva: alicuotas,
    Tributos: tributos
  };
}

function signoComprobanteWsfe(cbteTipo) {
  return new Set([3, 8, 13, 53, 203, 208, 213]).has(Number(cbteTipo)) ? -1 : 1;
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
  const payload = {
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
  return { ...payload, ...detalleFiscalWsfe(payload) };
}

function wslpgEndpoints(config) {
  return config.production
    ? [
      { url: 'https://serviciosjava.arca.gob.ar/wslpg/LpgService', namespace: 'http://serviciosjava.arca.gob.ar/wslpg/' },
      { url: 'https://serviciosjava.afip.gob.ar/wslpg/LpgService', namespace: 'http://serviciosjava.afip.gob.ar/wslpg/' }
    ]
    : [{ url: 'https://fwshomo.afip.gov.ar/wslpg/LpgService', namespace: 'http://serviciosjava.afip.gob.ar/wslpg/' }];
}

async function wslpgCall(operation, requestXml = '') {
  const config = getConfig();
  const ticket = await getTicket('wslpg');
  const auth = `<auth><token>${xmlEscape(ticket.token)}</token><sign>${xmlEscape(ticket.sign)}</sign><cuit>${config.cuit}</cuit></auth>`;
  let lastError;
  for (const endpoint of wslpgEndpoints(config)) {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsl="${endpoint.namespace}"><soapenv:Header/><soapenv:Body><wsl:${operation}>${auth}${requestXml}</wsl:${operation}></soapenv:Body></soapenv:Envelope>`;
    try {
      return await soapPost(endpoint.url, '', envelope);
    } catch (error) {
      lastError = error;
      if (error.code !== 'ARCA_TRANSPORT_ERROR') throw error;
    }
  }
  throw lastError || new Error('No fue posible conectar con WSLPG.');
}

const WSLPG_DOCUMENT_TYPES = Object.freeze([
  { id: 'LPG', fuente: 'WSLPG_LPG', ultimo: 'liqUltNroOrdenReq', consultar: 'liqConsXNroOrdenReq', resultTags: ['liqConsReturn'] },
  { id: 'LSG', fuente: 'WSLPG_LSG', ultimo: 'lsgConsultarUltimoNroOrdenReq', consultar: 'lsgConsultarXNroOrdenReq', resultTags: ['oReturn'] },
  { id: 'CERTIFICACION', fuente: 'WSLPG_CERTIFICACION', ultimo: 'cgConsultarUltimoNroOrdenReq', consultar: 'cgConsultarXNroOrdenReq', resultTags: ['oReturn'] }
]);

function fechaWslpg(xml) {
  const value = tag(xml, 'fechaLiquidacion') || tag(xml, 'fechaCertificacion') || tag(xml, 'fechaProceso');
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function wslpgBusinessError(xml) {
  const errors = tags(xml, 'error');
  if (!errors.length) return null;
  return errors.map(item => {
    const code = tag(item, 'codigo');
    const description = tag(item, 'descripcion');
    return [code, description].filter(Boolean).join(': ');
  }).filter(Boolean).join(' | ') || 'WSLPG devolviÃ³ un error de negocio.';
}

async function wslpgUltimoNroOrden(type, ptoEmision) {
  const xml = await wslpgCall(type.ultimo, `<ptoEmision>${ptoEmision}</ptoEmision>`);
  const error = wslpgBusinessError(xml);
  if (error) throw new Error(error);
  return Number(tag(xml, 'nroOrden') || 0);
}

async function wslpgConsultarNroOrden(type, ptoEmision, nroOrden) {
  const xml = await wslpgCall(
    type.consultar,
    `<ptoEmision>${ptoEmision}</ptoEmision><nroOrden>${nroOrden}</nroOrden>`
  );
  const error = wslpgBusinessError(xml);
  if (error) throw new Error(error);
  const result = type.resultTags.map(name => tag(xml, name)).find(Boolean);
  if (!result) throw new Error(`WSLPG no devolviÃ³ datos para ${type.id} ${ptoEmision}/${nroOrden}.`);
  return {
    tipoDocumento: type.id,
    ptoEmision,
    nroOrden,
    coe: tag(result, 'coe'),
    estado: tag(result, 'estado'),
    fecha: fechaWslpg(result),
    rawXml: result
  };
}

async function wslpgConsultarCoe(coe) {
  const safeCoe = String(coe || '').replace(/\D/g, '');
  if (!/^\d{12}$/.test(safeCoe)) throw new Error(`COE WSLPG invÃƒÂ¡lido: ${coe}`);
  const xml = await wslpgCall('liqConsXCoeReq', `<coe>${safeCoe}</coe>`);
  const error = wslpgBusinessError(xml);
  if (error) throw new Error(error);
  const result = tag(xml, 'liqConsReturn');
  if (!result) throw new Error(`WSLPG no devolviÃƒÂ³ datos para el COE ${safeCoe}.`);
  return {
    tipoDocumento: 'LPG',
    coe: tag(result, 'coe') || safeCoe,
    estado: tag(result, 'estado'),
    fecha: fechaWslpg(result),
    ptoEmision: Number(tag(result, 'ptoEmision') || 0) || null,
    nroOrden: Number(tag(result, 'nroOrden') || 0) || null,
    pdfBase64: tag(result, 'pdf') || null,
    rawXml: result
  };
}

async function importarWslpgPorCoe(coes) {
  await ensureSyncTables();
  const unicos = [...new Set((Array.isArray(coes) ? coes : [])
    .map(value => String(value || '').replace(/\D/g, ''))
    .filter(value => /^\d{12}$/.test(value)))];
  if (!unicos.length) throw new Error('Debe indicar al menos un COE WSLPG vÃƒÂ¡lido.');
  if (unicos.length > 1000) throw new Error('El lote no puede superar 1000 COE.');

  const resultados = [];
  for (const coe of unicos) {
    try {
      const document = await wslpgConsultarCoe(coe);
      await guardarDocumentoOficial('WSLPG_LPG_COE', coe, document.fecha, document);
      resultados.push({
        coe,
        ok: true,
        fecha: document.fecha,
        estado: document.estado,
        ptoEmision: document.ptoEmision,
        nroOrden: document.nroOrden,
        incluyePdf: Boolean(document.pdfBase64)
      });
    } catch (error) {
      resultados.push({ coe, ok: false, error: error.message });
    }
  }
  return {
    total: resultados.length,
    importados: resultados.filter(item => item.ok).length,
    conPdf: resultados.filter(item => item.ok && item.incluyePdf).length,
    errores: resultados.filter(item => !item.ok),
    resultados
  };
}

async function ejecutarSyncWslpg(jobId, desde, limite, puntosEmision) {
  await ensureSyncTables();
  await pool.query(
    "UPDATE arca_sync_jobs SET estado='EJECUTANDO', started_at=NOW() WHERE id=$1",
    [jobId]
  );
  let revisados = 0;
  let importados = 0;
  try {
    validateCredentials(getConfig());
    outer:
    for (const ptoEmision of puntosEmision) {
      for (const type of WSLPG_DOCUMENT_TYPES) {
        let ultimo;
        try {
          ultimo = await wslpgUltimoNroOrden(type, ptoEmision);
        } catch (error) {
          console.warn(`WSLPG ${type.id}, punto ${ptoEmision}: ${error.message}`);
          continue;
        }
        if (!Number.isInteger(ultimo) || ultimo <= 0) continue;
        for (let nroOrden = ultimo; nroOrden >= 1; nroOrden -= 1) {
          if (revisados >= limite) break outer;
          revisados += 1;
          let document;
          try {
            document = await wslpgConsultarNroOrden(type, ptoEmision, nroOrden);
          } catch (error) {
            console.warn(`WSLPG ${type.id} ${ptoEmision}/${nroOrden}: ${error.message}`);
            continue;
          }
          if (document.fecha && document.fecha < desde) break;
          if (!document.fecha || document.fecha < desde) continue;
          await guardarDocumentoOficial(type.fuente, `${ptoEmision}:${nroOrden}`, document.fecha, document);
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

async function iniciarSyncWslpg({ desde = '2026-01-01', limite = 2000, puntosEmision = [1], userId = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) throw new Error('La fecha desde debe usar formato AAAA-MM-DD.');
  const safeLimit = Math.max(1, Math.min(5000, Number(limite) || 2000));
  const safePoints = [...new Set((Array.isArray(puntosEmision) ? puntosEmision : [puntosEmision])
    .map(Number)
    .filter(value => Number.isInteger(value) && value >= 1 && value <= 9999))];
  if (!safePoints.length) throw new Error('Debe indicar al menos un punto de emisiÃ³n WSLPG vÃ¡lido.');
  await ensureSyncTables();
  const id = crypto.randomUUID();
  await pool.query(`
    INSERT INTO arca_sync_jobs(id, fuente, desde, estado, solicitado_por)
    VALUES($1,'WSLPG_GRANOS',$2,'PENDIENTE',$3)
  `, [id, desde, userId]);
  setImmediate(() => {
    void ejecutarSyncWslpg(id, desde, safeLimit, safePoints);
  });
  return {
    id,
    fuente: 'WSLPG_GRANOS',
    desde,
    limite: safeLimit,
    puntosEmision: safePoints,
    documentos: WSLPG_DOCUMENT_TYPES.map(type => type.id),
    estado: 'PENDIENTE'
  };
}

async function obtenerResumenDocumentos() {
  await ensureSyncTables();
  const { rows } = await pool.query(`
    SELECT fuente, COUNT(*)::integer AS total,
           MIN(document_date) AS fecha_desde,
           MAX(document_date) AS fecha_hasta,
           COUNT(DISTINCT payload_hash)::integer AS hashes_distintos
    FROM arca_official_documents
    GROUP BY fuente
    ORDER BY fuente
  `);
  return rows.map(row => ({
    ...row,
    integridad: row.total === row.hashes_distintos ? 'SIN_DUPLICADOS_DE_CONTENIDO' : 'REVISAR_CONTENIDO_REPETIDO'
  }));
}

async function listarDocumentosOficiales({
  fuente = 'WSFE_EMITIDA',
  desde = null,
  hasta = null,
  buscar = '',
  pagina = 1,
  limite = 50
} = {}) {
  await ensureSyncTables();
  const safePage = Math.max(1, Number(pagina) || 1);
  const safeLimit = Math.max(1, Math.min(200, Number(limite) || 50));
  const conditions = ['d.fuente = $1'];
  const params = [fuente];
  if (desde) {
    params.push(desde);
    conditions.push(`d.document_date >= $${params.length}`);
  }
  if (hasta) {
    params.push(hasta);
    conditions.push(`d.document_date <= $${params.length}`);
  }
  if (buscar) {
    params.push(`%${String(buscar).trim()}%`);
    conditions.push(`(
      d.external_key ILIKE $${params.length}
      OR COALESCE(d.payload->>'DocNro','') ILIKE $${params.length}
      OR COALESCE(cp.razon_social,'') ILIKE $${params.length}
    )`);
  }
  const where = conditions.join(' AND ');
  const offset = (safePage - 1) * safeLimit;
  const baseJoin = `
    FROM arca_official_documents d
    LEFT JOIN LATERAL (
      SELECT c.id, c.razon_social, c.cuit
      FROM contrapartes c
      WHERE c.activo = TRUE
        AND regexp_replace(COALESCE(c.cuit,''), '[^0-9]', '', 'g')
          = regexp_replace(COALESCE(d.payload->>'DocNro',''), '[^0-9]', '', 'g')
      ORDER BY c.id
      LIMIT 1
    ) cp ON TRUE
  `;
  const countResult = await pool.query(
    `SELECT COUNT(*)::integer AS total ${baseJoin} WHERE ${where}`,
    params
  );
  const queryParams = [...params, safeLimit, offset];
  const { rows } = await pool.query(`
    SELECT d.id, d.fuente, d.external_key, d.document_date,
           d.payload, d.payload_hash,
           d.first_imported_at, d.last_seen_at,
           cp.id AS contraparte_id, cp.razon_social AS contraparte_razon_social,
           cp.cuit AS contraparte_cuit
    ${baseJoin}
    WHERE ${where}
    ORDER BY d.document_date DESC NULLS LAST, d.id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, queryParams);
  return {
    documentos: rows.map(row => {
      const payload = row.payload || {};
      const { rawXml, ...publicPayload } = payload;
      return {
        ...row,
        payload: { ...publicPayload, ...detalleFiscalWsfe(payload) },
        contraparte_estado: row.contraparte_id ? 'VINCULADA' : 'PENDIENTE_ALTA'
      };
    }),
    paginacion: {
      pagina: safePage,
      limite: safeLimit,
      total: countResult.rows[0]?.total || 0,
      paginas: Math.ceil((countResult.rows[0]?.total || 0) / safeLimit)
    }
  };
}

async function resumirConciliacionContrapartes() {
  await ensureSyncTables();
  const { rows } = await pool.query(`
    WITH receptores AS (
      SELECT regexp_replace(COALESCE(payload->>'DocNro',''), '[^0-9]', '', 'g') AS cuit,
             COUNT(*)::integer AS comprobantes,
             SUM(COALESCE(NULLIF(payload->>'ImpTotal','')::numeric, 0)) AS importe_total
      FROM arca_official_documents
      WHERE fuente='WSFE_EMITIDA'
      GROUP BY 1
    )
    SELECT r.cuit, r.comprobantes, r.importe_total,
           cp.id AS contraparte_id, cp.razon_social,
           CASE WHEN cp.id IS NULL THEN 'PENDIENTE_ALTA' ELSE 'VINCULADA' END AS estado
    FROM receptores r
    LEFT JOIN LATERAL (
      SELECT c.id, c.razon_social
      FROM contrapartes c
      WHERE c.activo=TRUE
        AND regexp_replace(COALESCE(c.cuit,''), '[^0-9]', '', 'g') = r.cuit
      ORDER BY c.id
      LIMIT 1
    ) cp ON TRUE
    WHERE length(r.cuit)=11
    ORDER BY (cp.id IS NULL) DESC, r.comprobantes DESC, r.cuit
  `);
  return {
    totalCuits: rows.length,
    vinculadas: rows.filter(row => row.estado === 'VINCULADA').length,
    pendientes: rows.filter(row => row.estado === 'PENDIENTE_ALTA').length,
    receptores: rows
  };
}

async function resumirIvaVentas({ desde = null, hasta = null } = {}) {
  await ensureSyncTables();
  const conditions = ["fuente='WSFE_EMITIDA'"];
  const params = [];
  if (desde) {
    params.push(desde);
    conditions.push(`document_date >= $${params.length}`);
  }
  if (hasta) {
    params.push(hasta);
    conditions.push(`document_date <= $${params.length}`);
  }
  const { rows } = await pool.query(`
    SELECT id, external_key, document_date, payload, payload_hash
    FROM arca_official_documents
    WHERE ${conditions.join(' AND ')}
    ORDER BY document_date, id
  `, params);

  const totales = {
    comprobantes: rows.length,
    importeTotal: 0,
    netoGravado: 0,
    iva: 0,
    exento: 0,
    noGravado: 0,
    otrosTributos: 0
  };
  const periodos = new Map();
  const alicuotas = new Map();
  const tributos = new Map();
  const observaciones = [];

  for (const row of rows) {
    const payload = row.payload || {};
    const fiscal = detalleFiscalWsfe(payload);
    const signo = signoComprobanteWsfe(payload.CbteTipo);
    const periodo = String(row.document_date || '').slice(0, 7) || 'SIN_FECHA';
    const mensual = periodos.get(periodo) || {
      periodo,
      comprobantes: 0,
      importeTotal: 0,
      netoGravado: 0,
      iva: 0,
      exento: 0,
      noGravado: 0,
      otrosTributos: 0
    };
    mensual.comprobantes += 1;
    for (const [key, source] of [
      ['importeTotal', 'ImpTotal'],
      ['netoGravado', 'ImpNeto'],
      ['iva', 'ImpIVA'],
      ['exento', 'ImpOpEx'],
      ['noGravado', 'ImpTotConc'],
      ['otrosTributos', 'ImpTrib']
    ]) {
      const amount = signo * fiscal[source];
      totales[key] += amount;
      mensual[key] += amount;
    }
    periodos.set(periodo, mensual);

    for (const item of fiscal.AlicIva) {
      const key = String(item.Id || 0);
      const current = alicuotas.get(key) || { codigo: Number(item.Id || 0), baseImponible: 0, importeIva: 0 };
      current.baseImponible += signo * numeroFiscal(item.BaseImp);
      current.importeIva += signo * numeroFiscal(item.Importe);
      alicuotas.set(key, current);
    }
    for (const item of fiscal.Tributos) {
      const key = `${item.Id || 0}:${item.Desc || ''}`;
      const current = tributos.get(key) || {
        codigo: Number(item.Id || 0),
        descripcion: item.Desc || 'Sin descripciÃ³n',
        baseImponible: 0,
        importe: 0
      };
      current.baseImponible += signo * numeroFiscal(item.BaseImp);
      current.importe += signo * numeroFiscal(item.Importe);
      tributos.set(key, current);
    }

    const componentes = fiscal.ImpTotConc + fiscal.ImpNeto + fiscal.ImpOpEx + fiscal.ImpTrib + fiscal.ImpIVA;
    if (Math.abs(componentes - fiscal.ImpTotal) > 0.02) {
      observaciones.push({
        id: row.id,
        comprobante: row.external_key,
        fecha: row.document_date,
        tipo: Number(payload.CbteTipo || 0),
        diferencia: Number((fiscal.ImpTotal - componentes).toFixed(2)),
        payloadHash: row.payload_hash
      });
    }
  }

  const redondear = value => Number(value.toFixed(2));
  const redondearObjeto = item => Object.fromEntries(
    Object.entries(item).map(([key, value]) => [
      key,
      typeof value === 'number' && key !== 'comprobantes' && key !== 'codigo' ? redondear(value) : value
    ])
  );
  return {
    alcance: 'IVA_VENTAS_WSFE_EMITIDA',
    criterioNotasCredito: 'IMPORTES_CON_SIGNO_NEGATIVO',
    totales: redondearObjeto(totales),
    periodos: [...periodos.values()].map(redondearObjeto),
    alicuotas: [...alicuotas.values()].map(redondearObjeto).sort((a, b) => a.codigo - b.codigo),
    tributos: [...tributos.values()].map(redondearObjeto).sort((a, b) => a.codigo - b.codigo),
    controlIntegridad: { observados: observaciones.length, comprobantes: observaciones },
    advertencia: 'Borrador de control. No reemplaza IVA Simple, Libro IVA Digital ni la revisiÃ³n profesional.'
  };
}

async function listarConciliacionesCuentaCorriente({
  desde = null,
  hasta = null,
  estado = 'PENDIENTE',
  limite = 200
} = {}) {
  await ensureReconciliationTable();
  const safeLimit = Math.max(1, Math.min(500, Number(limite) || 200));
  const conditions = ["d.fuente='WSFE_EMITIDA'"];
  const params = [];
  if (desde) {
    params.push(desde);
    conditions.push(`d.document_date >= $${params.length}`);
  }
  if (hasta) {
    params.push(hasta);
    conditions.push(`d.document_date <= $${params.length}`);
  }
  if (estado === 'PENDIENTE') conditions.push('r.id IS NULL');
  if (estado === 'RESUELTO') conditions.push('r.id IS NOT NULL');
  params.push(safeLimit);
  const { rows } = await pool.query(`
    SELECT d.id AS document_id, d.external_key, d.document_date, d.payload_hash,
           d.payload->>'CbteTipo' AS cbte_tipo,
           d.payload->>'PtoVta' AS punto_venta,
           d.payload->>'CbteDesde' AS numero,
           d.payload->>'DocNro' AS receptor_cuit,
           COALESCE(NULLIF(d.payload->>'ImpTotal','')::numeric,0) AS importe,
           d.payload->>'MonId' AS moneda,
           cp.id AS contraparte_id, cp.razon_social AS contraparte,
           r.id AS conciliacion_id, r.estado, r.decision, r.cc_movimiento_id,
           r.observacion, r.decidido_por, r.decidido_at,
           candidato.id AS candidato_cc_id, candidato.fecha AS candidato_fecha,
           candidato.tipo_movimiento AS candidato_tipo,
           candidato.concepto AS candidato_concepto,
           ABS(candidato.debe-candidato.haber) AS candidato_importe
    FROM arca_official_documents d
    LEFT JOIN LATERAL (
      SELECT c.id, c.razon_social
      FROM contrapartes c
      WHERE c.activo=TRUE
        AND regexp_replace(COALESCE(c.cuit,''), '[^0-9]', '', 'g')
          = regexp_replace(COALESCE(d.payload->>'DocNro',''), '[^0-9]', '', 'g')
      ORDER BY c.id
      LIMIT 1
    ) cp ON TRUE
    LEFT JOIN arca_cc_reconciliations r ON r.document_id=d.id
    LEFT JOIN LATERAL (
      SELECT cc.id, cc.fecha, cc.tipo_movimiento, cc.concepto, cc.debe, cc.haber
      FROM cc_contrapartes cc
      WHERE cp.id IS NOT NULL
        AND cc.id_contraparte=cp.id
        AND cc.modalidad='FORMAL'
        AND ABS(ABS(cc.debe-cc.haber)-COALESCE(NULLIF(d.payload->>'ImpTotal','')::numeric,0)) <= 0.02
        AND ABS(cc.fecha-d.document_date) <= 31
      ORDER BY ABS(cc.fecha-d.document_date), cc.id
      LIMIT 1
    ) candidato ON TRUE
    WHERE ${conditions.join(' AND ')}
    ORDER BY d.document_date DESC, d.id DESC
    LIMIT $${params.length}
  `, params);
  return {
    estado,
    total: rows.length,
    pendientesSinContraparte: rows.filter(row => !row.contraparte_id).length,
    posiblesDuplicados: rows.filter(row => row.candidato_cc_id).length,
    conciliaciones: rows.map(row => ({
      ...row,
      recomendacion: !row.contraparte_id
        ? 'ALTA_CONTRAPARTE_REQUERIDA'
        : row.candidato_cc_id
          ? 'VINCULAR_EXISTENTE'
          : 'REVISAR_CREACION'
    }))
  };
}

async function decidirConciliacionCuentaCorriente({
  documentId,
  decision,
  ccMovimientoId = null,
  observacion = '',
  userId
}) {
  await ensureReconciliationTable();
  if (!userId) throw new Error('La decisiÃ³n requiere un usuario autenticado.');
  const allowed = new Set(['VINCULAR_EXISTENTE', 'CREAR_MOVIMIENTO', 'RECHAZAR']);
  if (!allowed.has(decision)) throw new Error('DecisiÃ³n de conciliaciÃ³n invÃ¡lida.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: documents } = await client.query(`
      SELECT d.*, cp.id AS contraparte_id
      FROM arca_official_documents d
      LEFT JOIN LATERAL (
        SELECT c.id
        FROM contrapartes c
        WHERE c.activo=TRUE
          AND regexp_replace(COALESCE(c.cuit,''), '[^0-9]', '', 'g')
            = regexp_replace(COALESCE(d.payload->>'DocNro',''), '[^0-9]', '', 'g')
        ORDER BY c.id LIMIT 1
      ) cp ON TRUE
      WHERE d.id=$1 AND d.fuente='WSFE_EMITIDA'
      FOR UPDATE OF d
    `, [documentId]);
    const document = documents[0];
    if (!document) throw new Error('Documento ARCA emitido no encontrado.');
    if (!document.contraparte_id) throw new Error('Debe dar de alta o vincular la contraparte antes de conciliar.');
    const existing = await client.query(
      'SELECT id FROM arca_cc_reconciliations WHERE document_id=$1',
      [documentId]
    );
    if (existing.rows[0]) throw new Error('El documento ARCA ya fue conciliado.');

    const payload = document.payload || {};
    const fiscal = detalleFiscalWsfe(payload);
    const importe = fiscal.ImpTotal;
    if (importe <= 0) throw new Error('El documento no tiene un importe total vÃ¡lido.');
    let movimientoId = null;
    let estado = 'RECHAZADO';

    if (decision === 'VINCULAR_EXISTENTE') {
      if (!ccMovimientoId) throw new Error('Debe indicar el movimiento existente.');
      const { rows } = await client.query(`
        SELECT id
        FROM cc_contrapartes
        WHERE id=$1 AND id_contraparte=$2 AND modalidad='FORMAL'
          AND ABS(ABS(debe-haber)-$3::numeric) <= 0.02
        FOR UPDATE
      `, [ccMovimientoId, document.contraparte_id, importe]);
      if (!rows[0]) throw new Error('El movimiento no corresponde a la contraparte o al importe del comprobante.');
      movimientoId = rows[0].id;
      estado = 'VINCULADO';
    }

    if (decision === 'CREAR_MOVIMIENTO') {
      if (payload.MonId && payload.MonId !== 'PES') {
        throw new Error('Los comprobantes en moneda extranjera requieren conciliaciÃ³n manual con cotizaciÃ³n.');
      }
      const signo = signoComprobanteWsfe(payload.CbteTipo);
      const debe = signo > 0 ? importe : 0;
      const haber = signo < 0 ? importe : 0;
      const { rows } = await client.query(`
        INSERT INTO cc_contrapartes
          (id_contraparte, fecha, tipo_movimiento, concepto, debe, haber,
           saldo_acumulado, modalidad, estado)
        VALUES ($1,$2,'DOCUMENTO_ARCA',$3,$4,$5,NULL,'FORMAL','ABIERTO')
        RETURNING id
      `, [
        document.contraparte_id,
        document.document_date,
        `ARCA ${payload.PtoVta || '-'}-${payload.CbteDesde || '-'} Â· ${document.payload_hash.slice(0, 12)}`,
        debe,
        haber
      ]);
      movimientoId = rows[0].id;
      estado = 'CREADO';
    }

    const { rows: reconciliations } = await client.query(`
      INSERT INTO arca_cc_reconciliations
        (document_id, contraparte_id, cc_movimiento_id, estado, decision,
         importe, payload_hash, observacion, decidido_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [
      document.id,
      document.contraparte_id,
      movimientoId,
      estado,
      decision,
      importe,
      document.payload_hash,
      String(observacion || '').slice(0, 500) || null,
      userId
    ]);
    await client.query('COMMIT');
    return reconciliations[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
  iniciarSyncWslpg,
  importarWslpgPorCoe,
  obtenerSyncJob,
  obtenerResumenDocumentos,
  listarDocumentosOficiales,
  resumirConciliacionContrapartes,
  resumirIvaVentas,
  listarConciliacionesCuentaCorriente,
  decidirConciliacionCuentaCorriente,
  diagnosticarCredenciales,
  _internal: {
    xmlEscape,
    decodeXml,
    tag,
    tags,
    fechaWslpg,
    wslpgBusinessError,
    detalleFiscalWsfe,
    signoComprobanteWsfe,
    getConfig,
    validateCredentials
  }
};
