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
let cpeMasterTablesReady = false;

function normalizarCuit(value) {
  const cuit = String(value || '').replace(/\D/g, '');
  return /^\d{11}$/.test(cuit) ? cuit : null;
}

function normalizarNumeroPlanta(value) {
  const numero = String(value || '').trim().replace(/^0+(?=\d)/, '');
  return numero || null;
}

function tipoContrapartePorRol(role) {
  const rol = String(role || '').toUpperCase();
  if (rol.includes('TRANSPORT')) return 'TRANSPORTISTA';
  if (rol.includes('CORREDOR')) return 'CORREDOR';
  if (rol.includes('PRODUCTOR') || rol.includes('VENDEDOR') || rol.includes('REMITENTE')) return 'PRODUCTOR';
  return 'COMPRADOR';
}

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

async function ensureCpeMasterTables() {
  if (cpeMasterTablesReady) return;
  await ensureSyncTables();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS arca_cpe_registry (
      ctg VARCHAR(20) PRIMARY KEY,
      document_id BIGINT NOT NULL UNIQUE REFERENCES arca_official_documents(id) ON DELETE RESTRICT,
      tipo_cpe VARCHAR(40) NOT NULL,
      first_imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS arca_cpe_participants (
      id BIGSERIAL PRIMARY KEY,
      document_id BIGINT NOT NULL REFERENCES arca_official_documents(id) ON DELETE CASCADE,
      ctg VARCHAR(20) NOT NULL REFERENCES arca_cpe_registry(ctg) ON DELETE CASCADE,
      rol VARCHAR(80) NOT NULL,
      cuit VARCHAR(11) NOT NULL,
      razon_social_oficial VARCHAR(200),
      contraparte_id INTEGER REFERENCES contrapartes(id) ON DELETE SET NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(document_id, rol, cuit)
    );
    CREATE INDEX IF NOT EXISTS idx_arca_cpe_participants_cuit
      ON arca_cpe_participants(cuit);
    CREATE TABLE IF NOT EXISTS arca_cpe_plants (
      id BIGSERIAL PRIMARY KEY,
      document_id BIGINT NOT NULL REFERENCES arca_official_documents(id) ON DELETE CASCADE,
      ctg VARCHAR(20) NOT NULL REFERENCES arca_cpe_registry(ctg) ON DELETE CASCADE,
      rol VARCHAR(80) NOT NULL,
      nro_planta VARCHAR(20) NOT NULL,
      cuit_titular VARCHAR(11),
      nombre_oficial VARCHAR(200),
      localidad VARCHAR(100),
      provincia VARCHAR(100),
      direccion VARCHAR(200),
      ubicacion_id INTEGER REFERENCES ubicaciones(id) ON DELETE SET NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(document_id, rol, nro_planta)
    );
    CREATE INDEX IF NOT EXISTS idx_arca_cpe_plants_number
      ON arca_cpe_plants(nro_planta, cuit_titular);
    CREATE TABLE IF NOT EXISTS arca_official_files (
      id BIGSERIAL PRIMARY KEY,
      document_id BIGINT NOT NULL REFERENCES arca_official_documents(id) ON DELETE CASCADE,
      file_type VARCHAR(20) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      content BYTEA NOT NULL,
      content_hash VARCHAR(64) NOT NULL,
      size_bytes INTEGER NOT NULL,
      first_imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(document_id, file_type, content_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_arca_official_files_document
      ON arca_official_files(document_id, file_type);
    CREATE TABLE IF NOT EXISTS arca_cpe_import_events (
      id BIGSERIAL PRIMARY KEY,
      ctg VARCHAR(20) NOT NULL REFERENCES arca_cpe_registry(ctg) ON DELETE RESTRICT,
      document_id BIGINT NOT NULL REFERENCES arca_official_documents(id) ON DELETE RESTRICT,
      job_id UUID REFERENCES arca_sync_jobs(id) ON DELETE SET NULL,
      imported_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      payload_hash VARCHAR(64) NOT NULL,
      pdf_hash VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_arca_cpe_import_events_ctg
      ON arca_cpe_import_events(ctg, created_at DESC);
  `);
  cpeMasterTablesReady = true;
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

function xmlToObject(xml) {
  const root = {};
  const stack = [{ value: root }];
  const tokens = String(xml || '').replace(/<!--[\s\S]*?-->/g, '').match(/<[^>]+>|[^<]+/g) || [];
  for (const token of tokens) {
    if (/^<\?/.test(token) || /^<!/.test(token)) continue;
    if (/^<\//.test(token)) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (/^</.test(token)) {
      const match = token.match(/^<\s*(?:\w+:)?([^\s/>]+)/);
      if (!match) continue;
      const name = match[1];
      const parent = stack[stack.length - 1].value;
      const node = {};
      if (Object.prototype.hasOwnProperty.call(parent, name)) {
        if (!Array.isArray(parent[name])) parent[name] = [parent[name]];
        parent[name].push(node);
      } else {
        parent[name] = node;
      }
      if (!/\/\s*>$/.test(token)) stack.push({ value: node, parent, name });
      continue;
    }
    const text = decodeXml(token.trim());
    if (!text || stack.length === 1) continue;
    const current = stack[stack.length - 1];
    if (Object.keys(current.value).length === 0) current.parent[current.name] = text;
    else current.value._text = (current.value._text || '') + text;
  }
  return root;
}

function extraerIntervinientesCpe(xml) {
  const roles = {
    cuitSolicitante: 'SOLICITANTE', cuitTitularPlanta: 'TITULAR_PLANTA',
    cuitOrigen: 'ORIGEN', cuitRemitenteComercial: 'REMITENTE_COMERCIAL',
    cuitRemitenteComercialVentaPrimaria: 'REMITENTE_COMERCIAL_VENTA_PRIMARIA',
    cuitRemitenteComercialVentaSecundaria: 'REMITENTE_COMERCIAL_VENTA_SECUNDARIA',
    cuitRemitenteComercialVentaSecundaria2: 'REMITENTE_COMERCIAL_VENTA_SECUNDARIA_2',
    cuitMercadoATermino: 'MERCADO_A_TERMINO', cuitCorredorVentaPrimaria: 'CORREDOR_VENTA_PRIMARIA',
    cuitCorredorVentaSecundaria: 'CORREDOR_VENTA_SECUNDARIA', cuitRepresentanteEntregador: 'REPRESENTANTE_ENTREGADOR',
    cuitRepresentanteRecibidor: 'REPRESENTANTE_RECIBIDOR', cuitComisionista: 'COMISIONISTA',
    cuitCorredor: 'CORREDOR', cuitTransportista: 'TRANSPORTISTA', cuitTransportistaTramo2: 'TRANSPORTISTA_TRAMO_2',
    cuitChofer: 'CHOFER', cuitConductor: 'CONDUCTOR', cuitConductorTramo2: 'CONDUCTOR_TRAMO_2',
    cuitPagadorFlete: 'PAGADOR_FLETE', cuitIntermediarioFlete: 'INTERMEDIARIO_FLETE'
  };
  const result = [];
  for (const [field, rol] of Object.entries(roles)) {
    for (const value of tags(xml, field)) {
      const cuit = normalizarCuit(value);
      if (cuit) result.push({ rol, cuit, campoOficial: field });
    }
  }
  for (const [blockName, rol] of [['origen', 'ORIGEN'], ['destino', 'DESTINO'], ['destinatario', 'DESTINATARIO']]) {
    const block = tag(xml, blockName);
    const cuit = normalizarCuit(tag(block || '', 'cuit') || tag(block || '', 'cuitOrigen'));
    if (cuit) result.push({ rol, cuit, campoOficial: `${blockName}.cuit` });
  }
  return [...new Map(result.map(item => [`${item.rol}:${item.cuit}`, item])).values()];
}

function extraerPlantasCpe(xml) {
  const result = [];
  for (const rol of ['origen', 'destino', 'cabecera']) {
    const bloque = tag(xml, rol);
    if (!bloque) continue;
    const numero = normalizarNumeroPlanta(tag(bloque, 'planta'));
    if (!numero) continue;
    result.push({
      rol: rol.toUpperCase(),
      numero,
      cuitTitular: normalizarCuit(tag(bloque, 'cuitTitularPlanta') || tag(bloque, 'cuit')),
      nombre: tag(bloque, 'plantaAFIP') || tag(bloque, 'plantaObservaciones') || null,
      localidad: tag(bloque, 'localidad') || tag(bloque, 'descripcionLocalidad') || null,
      provincia: tag(bloque, 'provincia') || tag(bloque, 'descripcionProvincia') || null,
      direccion: tag(bloque, 'domicilioOrigen') || tag(bloque, 'domicilioDestino') || tag(bloque, 'domicilio') || null
    });
  }
  return result;
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

function parsearPersonaPadronA13(xml) {
  const personaReturn = tag(xml, 'personaReturn');
  const personaXml = tag(personaReturn || xml, 'persona');
  if (!personaXml) throw new Error('Padrón A13 no devolvió datos de la persona consultada.');

  const domicilios = tags(personaXml, 'domicilio').map(domicilioXml => ({
    tipoDomicilio: tag(domicilioXml, 'tipoDomicilio'),
    direccion: tag(domicilioXml, 'direccion'),
    localidad: tag(domicilioXml, 'localidad'),
    codigoPostal: tag(domicilioXml, 'codigoPostal') || tag(domicilioXml, 'codPostal'),
    idProvincia: tag(domicilioXml, 'idProvincia'),
    descripcionProvincia: tag(domicilioXml, 'descripcionProvincia')
  }));
  const domicilioFiscal = domicilios.find(item => item.tipoDomicilio === 'FISCAL') || domicilios[0] || {};
  const nombre = tag(personaXml, 'nombre');
  const apellido = tag(personaXml, 'apellido');
  const razonSocial = tag(personaXml, 'razonSocial') || [apellido, nombre].filter(Boolean).join(' ');

  return {
    datosGenerales: {
      idPersona: tag(personaXml, 'idPersona'),
      tipoPersona: tag(personaXml, 'tipoPersona'),
      tipoClave: tag(personaXml, 'tipoClave'),
      estadoClave: tag(personaXml, 'estadoClave'),
      nombre,
      apellido,
      razonSocial,
      domicilioFiscal
    },
    persona: {
      idPersona: tag(personaXml, 'idPersona'),
      tipoPersona: tag(personaXml, 'tipoPersona'),
      estadoClave: tag(personaXml, 'estadoClave'),
      nombre,
      apellido,
      razonSocial,
      formaJuridica: tag(personaXml, 'formaJuridica'),
      idActividadPrincipal: tag(personaXml, 'idActividadPrincipal'),
      descripcionActividadPrincipal: tag(personaXml, 'descripcionActividadPrincipal'),
      domicilios
    }
  };
}

async function consultarPadronA13(cuitConsultar) {
  const config = getConfig();
  const cuit = String(cuitConsultar || '').replace(/\D/g, '');
  if (cuit.length !== 11) throw new Error('El CUIT consultado debe tener 11 dígitos.');
  const ticket = await getTicket('ws_sr_padron_a13');
  const url = config.production
    ? 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA13'
    : 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA13';
  const envelope = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a13="http://a13.soap.ws.server.puc.sr/"><soapenv:Header/><soapenv:Body><a13:getPersona><token>${xmlEscape(ticket.token)}</token><sign>${xmlEscape(ticket.sign)}</sign><cuitRepresentada>${config.cuit}</cuitRepresentada><idPersona>${cuit}</idPersona></a13:getPersona></soapenv:Body></soapenv:Envelope>`;
  return parsearPersonaPadronA13(await soapPost(url, '', envelope));
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

function decodificarPdfWslpg(pdfBase64) {
  if (!pdfBase64) return null;
  const content = Buffer.from(String(pdfBase64).replace(/\s/g, ''), 'base64');
  if (content.length < 5 || content.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('ARCA devolvi\u00f3 un PDF WSLPG inv\u00e1lido.');
  }
  return content;
}

function omitirPdfXml(xml) {
  return String(xml || '').replace(
    /<((?:[A-Za-z_][\w.-]*:)?pdf)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi,
    '<pdf>[ALMACENADO_COMO_ARCHIVO]</pdf>'
  );
}

function payloadOficialSinPdf(payload = {}) {
  const limpio = { ...payload };
  delete limpio.pdfBase64;
  delete limpio.pdfBuffer;
  if (limpio.rawXml) limpio.rawXml = omitirPdfXml(limpio.rawXml);
  return limpio;
}

async function guardarDocumentoOficial(fuente, externalKey, documentDate, payload, pdfBuffer = null) {
  if (pdfBuffer) await ensureCpeMasterTables();
  const payloadPersistido = payloadOficialSinPdf(payload);
  const serialized = JSON.stringify(payloadPersistido);
  const hash = crypto.createHash('sha256').update(serialized).digest('hex');
  const { rows, rowCount } = await pool.query(`
    INSERT INTO arca_official_documents
      (fuente, external_key, document_date, payload, payload_hash)
    VALUES ($1,$2,$3,$4::jsonb,$5)
    ON CONFLICT(fuente, external_key) DO UPDATE SET
      document_date=EXCLUDED.document_date,
      payload=EXCLUDED.payload,
      payload_hash=EXCLUDED.payload_hash,
      last_seen_at=NOW()
    RETURNING id
  `, [fuente, externalKey, documentDate, serialized, hash]);
  const documentId = rows[0]?.id || null;
  let pdfGuardado = false;
  let pdfHash = null;
  if (pdfBuffer && documentId) {
    const content = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
    if (content.length < 5 || content.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error(`ARCA devolvi\u00f3 un PDF inv\u00e1lido para ${fuente} ${externalKey}.`);
    }
    pdfHash = crypto.createHash('sha256').update(content).digest('hex');
    await pool.query(`
      INSERT INTO arca_official_files
        (document_id,file_type,mime_type,content,content_hash,size_bytes)
      VALUES ($1,'PDF','application/pdf',$2,$3,$4)
      ON CONFLICT(document_id,file_type,content_hash) DO UPDATE SET last_seen_at=NOW()
    `, [documentId, content, pdfHash, content.length]);
    pdfGuardado = true;
  }
  return { actualizado: rowCount > 0, documentId, pdfGuardado, pdfHash };
}

async function importarCpeNormalizada({ ctg, tipoCpe, fecha, payload, intervinientes = [], plantas = [], pdfBuffer = null, jobId = null, userId = null }) {
  const ctgNormalizado = String(ctg || '').replace(/\D/g, '');
  if (!/^\d{8,20}$/.test(ctgNormalizado)) throw new Error(`CTG inválido: ${ctg}`);
  if (!tipoCpe) throw new Error('El tipo de CPE es obligatorio.');
  await ensureCpeMasterTables();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const serialized = JSON.stringify(payload || {});
    const hash = crypto.createHash('sha256').update(serialized).digest('hex');
    const { rows: documents } = await client.query(`
      INSERT INTO arca_official_documents
        (fuente, external_key, document_date, payload, payload_hash)
      VALUES ('WSCPE_CPE',$1,$2,$3::jsonb,$4)
      ON CONFLICT(fuente, external_key) DO UPDATE SET
        document_date=EXCLUDED.document_date,
        payload=EXCLUDED.payload,
        payload_hash=EXCLUDED.payload_hash,
        last_seen_at=NOW()
      RETURNING id
    `, [ctgNormalizado, fecha || null, serialized, hash]);
    const documentId = documents[0].id;

    await client.query(`
      INSERT INTO arca_cpe_registry (ctg, document_id, tipo_cpe)
      VALUES ($1,$2,$3)
      ON CONFLICT(ctg) DO UPDATE SET
        document_id=EXCLUDED.document_id,
        tipo_cpe=EXCLUDED.tipo_cpe,
        last_seen_at=NOW()
    `, [ctgNormalizado, documentId, String(tipoCpe).slice(0, 40)]);

    let pdfGuardado = false;
    let pdfHash = null;
    if (pdfBuffer) {
      const content = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
      if (content.length < 5 || content.subarray(0, 5).toString('ascii') !== '%PDF-') {
        throw new Error(`ARCA devolvió un PDF inválido para CTG ${ctgNormalizado}.`);
      }
      const contentHash = crypto.createHash('sha256').update(content).digest('hex');
      pdfHash = contentHash;
      await client.query(`
        INSERT INTO arca_official_files
          (document_id,file_type,mime_type,content,content_hash,size_bytes)
        VALUES ($1,'PDF','application/pdf',$2,$3,$4)
        ON CONFLICT(document_id,file_type,content_hash) DO UPDATE SET last_seen_at=NOW()
      `, [documentId, content, contentHash, content.length]);
      pdfGuardado = true;
    }

    let contrapartesCreadas = 0;
    let contrapartesVinculadas = 0;
    for (const item of intervinientes) {
      const cuit = normalizarCuit(item.cuit);
      const rol = String(item.rol || '').trim().slice(0, 80);
      if (!cuit || !rol) continue;
      let razonSocial = String(item.razonSocial || item.razon_social || '').trim().slice(0, 200) || null;
      const { rows: existentes } = await client.query(
        "SELECT id FROM contrapartes WHERE regexp_replace(COALESCE(cuit,''),'[^0-9]','','g')=$1 ORDER BY activo DESC, id LIMIT 1",
        [cuit]
      );
      let contraparteId = existentes[0]?.id || null;
      if (!contraparteId && !razonSocial) {
        try {
          const padron = await consultarPadronA13(cuit);
          razonSocial = String(padron?.datosGenerales?.razonSocial || '').trim().slice(0, 200) || null;
        } catch (error) {
          console.warn(`Padrón A13 no resolvió el CUIT ${cuit}: ${error.message}`);
        }
      }
      if (!contraparteId && razonSocial) {
        const { rows: creadas } = await client.query(`
          INSERT INTO contrapartes
            (codigo_interno,cuit,razon_social,tipo_contraparte,canal_operacion,observaciones)
          VALUES ($1,$2,$3,$4,'FORMAL',$5)
          ON CONFLICT(codigo_interno) DO UPDATE SET updated_at=NOW()
          RETURNING id
        `, [`ARCA-${cuit}`, cuit, razonSocial, tipoContrapartePorRol(rol), `Alta automática desde CPE CTG ${ctgNormalizado}`]);
        contraparteId = creadas[0].id;
        contrapartesCreadas += 1;
      }
      if (contraparteId) contrapartesVinculadas += 1;
      await client.query(`
        INSERT INTO arca_cpe_participants
          (document_id,ctg,rol,cuit,razon_social_oficial,contraparte_id,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT(document_id,rol,cuit) DO UPDATE SET
          razon_social_oficial=COALESCE(EXCLUDED.razon_social_oficial,arca_cpe_participants.razon_social_oficial),
          contraparte_id=COALESCE(EXCLUDED.contraparte_id,arca_cpe_participants.contraparte_id),
          payload=EXCLUDED.payload,
          updated_at=NOW()
      `, [documentId, ctgNormalizado, rol, cuit, razonSocial, contraparteId, JSON.stringify(item)]);
    }

    let plantasCreadas = 0;
    let plantasVinculadas = 0;
    for (const item of plantas) {
      const numero = normalizarNumeroPlanta(item.numero || item.nroPlanta || item.nro_planta);
      const rol = String(item.rol || '').trim().slice(0, 80);
      if (!numero || !rol) continue;
      const cuitTitular = normalizarCuit(item.cuitTitular || item.cuit_titular);
      const { rows: existentes } = await client.query(`
        SELECT id FROM ubicaciones
        WHERE nro_planta=$1
          AND ($2::text IS NULL OR regexp_replace(COALESCE(cuit_titular,''),'[^0-9]','','g')=$2)
        ORDER BY activo DESC, id LIMIT 1
      `, [numero, cuitTitular]);
      let ubicacionId = existentes[0]?.id || null;
      if (!ubicacionId) {
        const nombre = String(item.nombre || `Planta ${numero}`).trim().slice(0, 200);
        const { rows: creadas } = await client.query(`
          INSERT INTO ubicaciones
            (nombre,tipo,localidad,provincia,direccion,cuit_titular,nro_planta)
          VALUES ($1,'DESTINO_ENTREGA',$2,$3,$4,$5,$6)
          RETURNING id
        `, [nombre, item.localidad || null, item.provincia || null, item.direccion || null, cuitTitular, numero]);
        ubicacionId = creadas[0].id;
        plantasCreadas += 1;
      }
      plantasVinculadas += 1;
      if (cuitTitular) {
        const { rows: titulares } = await client.query(
          "SELECT id FROM contrapartes WHERE regexp_replace(COALESCE(cuit,''),'[^0-9]','','g')=$1 ORDER BY activo DESC, id LIMIT 1",
          [cuitTitular]
        );
        if (titulares[0]) {
          await client.query(`
            INSERT INTO contraparte_ubicaciones (id_contraparte,id_ubicacion)
            VALUES ($1,$2) ON CONFLICT(id_contraparte,id_ubicacion) DO NOTHING
          `, [titulares[0].id, ubicacionId]);
        }
      }
      await client.query(`
        INSERT INTO arca_cpe_plants
          (document_id,ctg,rol,nro_planta,cuit_titular,nombre_oficial,localidad,provincia,direccion,ubicacion_id,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
        ON CONFLICT(document_id,rol,nro_planta) DO UPDATE SET
          cuit_titular=COALESCE(EXCLUDED.cuit_titular,arca_cpe_plants.cuit_titular),
          nombre_oficial=COALESCE(EXCLUDED.nombre_oficial,arca_cpe_plants.nombre_oficial),
          localidad=COALESCE(EXCLUDED.localidad,arca_cpe_plants.localidad),
          provincia=COALESCE(EXCLUDED.provincia,arca_cpe_plants.provincia),
          direccion=COALESCE(EXCLUDED.direccion,arca_cpe_plants.direccion),
          ubicacion_id=EXCLUDED.ubicacion_id,
          payload=EXCLUDED.payload,
          updated_at=NOW()
      `, [documentId, ctgNormalizado, rol, numero, cuitTitular, item.nombre || null, item.localidad || null, item.provincia || null, item.direccion || null, ubicacionId, JSON.stringify(item)]);
    }
    await client.query(`
      INSERT INTO arca_cpe_import_events
        (ctg,document_id,job_id,imported_by,payload_hash,pdf_hash)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [ctgNormalizado, documentId, jobId, userId, hash, pdfHash]);
    await client.query('COMMIT');
    return {
      ctg: ctgNormalizado,
      documentId,
      intervinientes: intervinientes.length,
      contrapartesCreadas,
      contrapartesVinculadas,
      plantas: plantas.length,
      plantasCreadas,
      plantasVinculadas,
      pdfGuardado
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const WSCPE_DETAIL_METHODS = Object.freeze([
  { method: 'consultarCPEAutomotor', element: 'ConsultarCPEAutomotorReq', tipo: 'AUTOMOTOR' },
  { method: 'consultarCPEFerroviaria', element: 'ConsultarCPEFerroviariaReq', tipo: 'FERROVIARIA' },
  { method: 'consultarCPEAutomotorDG', element: 'ConsultarCPEAutomotorDGReq', tipo: 'AUTOMOTOR_DG' },
  { method: 'consultarCPEFerroviariaDG', element: 'ConsultarCPEFerroviariaDGReq', tipo: 'FERROVIARIA_DG' },
  { method: 'consultarCPEEmisionDestinoDG', element: 'ConsultarCPEEmisionDestinoDGReq', tipo: 'EMISION_DESTINO_DG' },
  { method: 'consultarCPEDuctos', element: 'ConsultarCPEDuctosReq', tipo: 'DUCTOS_DG' }
]);

function wscpeTargets(production) {
  const currentUrl = production
    ? 'https://cpea-ws.arca.gob.ar/wscpe/services/soap'
    : 'https://cpea-ws-qaext.arca.gob.ar/wscpe/services/soap';
  const legacyUrl = production
    ? 'https://cpea-ws.afip.gob.ar/wscpe/services/soap'
    : 'https://cpea-ws-qaext.afip.gob.ar/wscpe/services/soap';
  return [
    { url: legacyUrl, namespace: 'https://serviciosjava.afip.gob.ar/wscpe/' },
    { url: legacyUrl, namespace: 'http://serviciosjava.afip.gob.ar/wscpe/' },
    { url: currentUrl, namespace: 'https://serviciosjava.arca.gob.ar/wscpe/' },
    { url: currentUrl, namespace: 'http://serviciosjava.arca.gob.ar/wscpe/' },
    { url: currentUrl, namespace: 'https://serviciosjava.afip.gob.ar/wscpe/' }
  ];
}

async function wscpeCall(definition, requestXml) {
  const config = getConfig();
  const ticket = await getTicket('wscpe');
  const auth = `<auth><token>${xmlEscape(ticket.token)}</token><sign>${xmlEscape(ticket.sign)}</sign><cuitRepresentada>${config.cuit}</cuitRepresentada></auth>`;
  const failures = [];
  for (const target of wscpeTargets(config.production)) {
    const solicitud = definition.sinSolicitud ? '' : `<solicitud>${requestXml}</solicitud>`;
    const envelope = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsc="${target.namespace}"><soapenv:Header/><soapenv:Body><wsc:${definition.element}>${auth}${solicitud}</wsc:${definition.element}></soapenv:Body></soapenv:Envelope>`;
    try {
      return await soapPost(target.url, `${target.namespace}${definition.method}`, envelope);
    } catch (error) {
      failures.push(`${new URL(target.url).hostname} ${target.namespace}: ${error.message}`);
    }
  }
  throw new Error(`WSCPE no respondio con ningun endpoint oficial: ${failures.join(' | ')}`);
}

function catalogoCodigoDescripcion(xml, etiqueta) {
  return tags(tag(xml, 'respuesta') || xml, etiqueta).map(item => ({
    codigo: textoEscalarOficial(tag(item, 'codigo')),
    descripcion: textoEscalarOficial(tag(item, 'descripcion'))
  })).filter(item => item.codigo && item.descripcion);
}

async function consultarTiposGranoWscpe() {
  const xml = await wscpeCall({ method: 'consultarTiposGrano', element: 'ConsultarTiposGranoReq', sinSolicitud: true }, '');
  const errores = erroresWscpe(xml);
  if (errores.length) throw new Error(`WSCPE consultarTiposGrano: ${errores.join(' | ')}`);
  return catalogoCodigoDescripcion(xml, 'grano');
}

async function consultarDerivadosGranariosWscpe() {
  const config = getConfig();
  const xml = await wscpeCall({ method: 'consultarDerivadosGranarios', element: 'ConsultarDerivadosGranariosReq' }, `<cuit>${xmlEscape(config.cuit)}</cuit>`);
  const errores = erroresWscpe(xml);
  if (errores.length) throw new Error(`WSCPE consultarDerivadosGranarios: ${errores.join(' | ')}`);
  return catalogoCodigoDescripcion(xml, 'derivadoGranario').concat(catalogoCodigoDescripcion(xml, 'derivado'));
}

function erroresWscpe(xml) {
  const errors = [];
  for (const item of tags(xml, 'error')) {
    const code = tag(item, 'codigo') || tag(item, 'code');
    const description = tag(item, 'descripcion') || tag(item, 'description') || item;
    errors.push([code, description].filter(Boolean).join(': '));
  }
  return errors.filter(Boolean);
}

function fechaCpe(xml) {
  const value = tag(xml, 'fechaEmision') || tag(xml, 'fechaPartida') || tag(xml, 'fechaHoraPartida');
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

async function consultarCpePorCtg(ctg) {
  const safeCtg = String(ctg || '').replace(/\D/g, '');
  if (!/^\d{8,20}$/.test(safeCtg)) throw new Error(`CTG inválido: ${ctg}`);
  const errors = [];
  for (const definition of WSCPE_DETAIL_METHODS) {
    try {
      const xml = await wscpeCall(definition, `<nroCTG>${safeCtg}</nroCTG>`);
      const businessErrors = erroresWscpe(xml);
      const respuesta = tag(xml, 'respuesta');
      const pdfBase64 = respuesta ? tag(respuesta, 'pdf') : null;
      if (businessErrors.length || !respuesta || !tag(respuesta, 'cabecera')) {
        errors.push(`${definition.tipo}: ${businessErrors.join(' | ') || 'sin datos'}`);
        continue;
      }
      const pdfBuffer = pdfBase64 ? Buffer.from(pdfBase64.replace(/\s/g, ''), 'base64') : null;
      const respuestaSinPdf = respuesta.replace(
        /<(?:\w+:)?pdf(?:\s[^>]*)?>[\s\S]*?<\/(?:\w+:)?pdf>/i,
        pdfBuffer ? `<pdfHash>${crypto.createHash('sha256').update(pdfBuffer).digest('hex')}</pdfHash>` : ''
      );
      return {
        ctg: safeCtg,
        tipoCpe: definition.tipo,
        fecha: fechaCpe(respuesta),
        payload: { tipoCpe: definition.tipo, detalle: xmlToObject(respuestaSinPdf), rawXml: respuestaSinPdf },
        intervinientes: extraerIntervinientesCpe(respuesta),
        plantas: extraerPlantasCpe(respuesta),
        pdfBuffer
      };
    } catch (error) {
      errors.push(`${definition.tipo}: ${error.message}`);
    }
  }
  throw new Error(`WSCPE no encontró el CTG ${safeCtg}. ${errors.join(' | ')}`);
}

function validarFechaIso(value, label) {
  const text = String(value || '');
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)
      || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`${label} debe usar formato AAAA-MM-DD.`);
  }
  return text;
}

function sumarDiasIso(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// ARCA WSCPE rechaza consultarCPEPorDestino cuando el intervalo inclusivo
// supera tres dias (error 2152). Mantener este limite en un solo lugar evita
// que una sincronizacion historica falle completa por usar bloques mensuales.
function rangosWscpe(desde, hasta, diasPorRango = 3) {
  const result = [];
  let cursor = validarFechaIso(desde, 'La fecha desde');
  const end = validarFechaIso(hasta, 'La fecha hasta');
  if (cursor > end) throw new Error('La fecha desde no puede ser posterior a la fecha hasta.');
  while (cursor <= end) {
    const candidate = sumarDiasIso(cursor, diasPorRango - 1);
    const rangeEnd = candidate < end ? candidate : end;
    result.push({ desde: cursor, hasta: rangeEnd });
    cursor = sumarDiasIso(rangeEnd, 1);
  }
  return result;
}

function esRespuestaSinResultadosWscpe(errors) {
  return errors.length > 0 && errors.every(message =>
    /no (?:se )?(?:encontr|hall)|sin (?:datos|resultados)|no existen/i.test(message)
  );
}

function normalizarEstadoCpe(value) {
  return String(value || '').trim().toUpperCase();
}

function esEstadoConfirmadoCpe(value) {
  return normalizarEstadoCpe(value) === 'CN';
}

function estadoCpeDesdePayload(payload = {}) {
  const rawXml = String(payload.rawXml || payload.raw_xml || '');
  return normalizarEstadoCpe(
    payload.estado ||
    payload.cabecera?.estado ||
    payload.detalle?.cabecera?.estado ||
    primerTag(rawXml, ['estado', 'estadoCartaPorte'])
  );
}

function clasificarOrigenCtg(ctg) {
  const normalizado = String(ctg || '').replace(/\D/g, '');
  if (normalizado.startsWith('101')) {
    return { tipoOrigenCpe: 'PRODUCTOR', origenProduccion: 'PROPIA' };
  }
  if (normalizado.startsWith('102')) {
    return { tipoOrigenCpe: 'PLANTA', origenProduccion: 'ACOPIO' };
  }
  return { tipoOrigenCpe: null, origenProduccion: null };
}

async function consultarPlantasWscpe(cuitConsultar = null) {
  const config = getConfig();
  const cuit = normalizarCuit(cuitConsultar || config.cuit);
  if (!cuit) throw new Error('El CUIT para consultar plantas debe tener 11 digitos.');
  const xml = await wscpeCall(
    { method: 'consultarPlantas', element: 'ConsultarPlantasReq' },
    `<cuit>${cuit}</cuit>`
  );
  const respuesta = tag(xml, 'respuesta') || xml;
  const errors = erroresWscpe(respuesta);
  if (errors.length && !esRespuestaSinResultadosWscpe(errors)) {
    throw new Error(`WSCPE consultarPlantas: ${errors.join(' | ')}`);
  }
  const plantas = tags(respuesta, 'planta').map(item => ({
    nroPlanta: normalizarNumeroPlanta(tag(item, 'nroPlanta')),
    codProvincia: tag(item, 'codProvincia') || null,
    codLocalidad: tag(item, 'codLocalidad') || null,
    latitud: tag(item, 'latitud') || null,
    longitud: tag(item, 'longitud') || null,
    ubicacionGeoreferencial: tag(item, 'ubicacionGeoreferencial') || null
  })).filter(item => item.nroPlanta);
  return [...new Map(plantas.map(item => [item.nroPlanta, item])).values()];
}

async function consultarCpesDestinoWscpe({ planta, desde, hasta, tipoCartaPorte = null }) {
  const nroPlanta = normalizarNumeroPlanta(planta);
  if (!nroPlanta) throw new Error('El numero de planta es obligatorio.');
  const fechaDesde = validarFechaIso(desde, 'La fecha desde');
  const fechaHasta = validarFechaIso(hasta, 'La fecha hasta');
  const tipoXml = tipoCartaPorte
    ? `<tipoCartaPorte>${xmlEscape(String(tipoCartaPorte))}</tipoCartaPorte>`
    : '';
  const xml = await wscpeCall(
    { method: 'consultarCPEPorDestino', element: 'ConsultarCPEPorDestinoReq' },
    `<planta>${xmlEscape(nroPlanta)}</planta><fechaPartidaDesde>${fechaDesde}</fechaPartidaDesde><fechaPartidaHasta>${fechaHasta}</fechaPartidaHasta>${tipoXml}`
  );
  const respuesta = tag(xml, 'respuesta') || xml;
  const errors = erroresWscpe(respuesta);
  if (errors.length && !esRespuestaSinResultadosWscpe(errors)) {
    throw new Error(`WSCPE consultarCPEPorDestino planta ${nroPlanta}: ${errors.join(' | ')}`);
  }
  return tags(respuesta, 'cartaPorte').map(item => ({
    ctg: String(tag(item, 'nroCTG') || '').replace(/\D/g, ''),
    fechaPartida: tag(item, 'fechaPartida') || null,
    estado: tag(item, 'estado') || null,
    fechaUltimaModificacion: tag(item, 'fechaUltimaModificacion') || null,
    nroPlanta
  })).filter(item => /^\d{8,20}$/.test(item.ctg));
}

async function importarCpePorCtg(ctg, context = {}) {
  const detail = await consultarCpePorCtg(ctg);
  return importarCpeNormalizada({ ...detail, ...context });
}

async function obtenerPdfDocumento(documentId) {
  await ensureCpeMasterTables();
  const { rows } = await pool.query(`
    SELECT f.content, f.mime_type, f.content_hash, f.size_bytes, d.external_key
    FROM arca_official_files f
    JOIN arca_official_documents d ON d.id=f.document_id
    WHERE f.document_id=$1 AND f.file_type='PDF'
    ORDER BY f.last_seen_at DESC LIMIT 1
  `, [documentId]);
  return rows[0] || null;
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

const WSLPG_COE_DOCUMENT_TYPES = Object.freeze({
  330: { id: 'LPG', fuente: 'WSLPG_LPG_COE', consultar: 'liqConsXCoeReq', resultTag: 'liqConsReturn' },
  331: { id: 'LSG', fuente: 'WSLPG_LSG_COE', consultar: 'lsgConsultarXCoeReq', resultTag: 'oReturn' },
  332: { id: 'CERTIFICACION', fuente: 'WSLPG_CERTIFICACION_COE', consultar: 'cgConsultarXCoeReq', resultTag: 'oReturn' }
});

function tipoWslpgPorCoe(coe) {
  const safeCoe = String(coe || '').replace(/\D/g, '');
  if (!/^\d{12}$/.test(safeCoe)) throw new Error(`COE WSLPG inv\u00e1lido: ${coe}`);
  const definition = WSLPG_COE_DOCUMENT_TYPES[safeCoe.slice(0, 3)];
  if (!definition) throw new Error(`El prefijo del COE ${safeCoe} no corresponde a LPG, LSG ni certificaci\u00f3n.`);
  return { ...definition, coe: safeCoe };
}

function solicitudWslpgPorCoe(coe) {
  const definition = tipoWslpgPorCoe(coe);
  return { definition, requestXml: `<coe>${definition.coe}</coe><pdf>S</pdf>` };
}

// Los ajustes LPG tienen un metodo de consulta propio en WSLPG. Se mantiene
// separado de solicitudWslpgPorCoe para no alterar la descarga de liquidaciones.
function solicitudAjusteWslpgPorCoe(coe) {
  const safeCoe = String(coe || '').replace(/\D/g, '');
  if (!/^330\d{9}$/.test(safeCoe)) {
    throw new Error(`COE de ajuste WSLPG invalido: ${coe}`);
  }
  return {
    coe: safeCoe,
    operation: 'ajusteXCoeConsReq',
    resultTag: 'ajusteConsReturn',
    payloadTag: 'ajusteUnificado',
    requestXml: `<coe>${safeCoe}</coe><pdf>S</pdf>`
  };
}

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
  const { definition, requestXml } = solicitudWslpgPorCoe(coe);
  const safeCoe = definition.coe;
  if (!/^\d{12}$/.test(safeCoe)) throw new Error(`COE WSLPG invÃƒÂ¡lido: ${coe}`);
  const xml = await wslpgCall(definition.consultar, requestXml);
  const error = wslpgBusinessError(xml);
  if (error) throw new Error(error);
  const result = tag(xml, definition.resultTag);
  if (!result) throw new Error(`WSLPG no devolviÃƒÂ³ datos para el COE ${safeCoe}.`);
  return {
    tipoDocumento: definition.id,
    fuente: definition.fuente,
    coe: tag(result, 'coe') || safeCoe,
    estado: tag(result, 'estado'),
    fecha: fechaWslpg(result),
    ptoEmision: Number(tag(result, 'ptoEmision') || 0) || null,
    nroOrden: Number(tag(result, 'nroOrden') || 0) || null,
    pdfBase64: tag(result, 'pdf') || null,
    rawXml: result
  };
}

function parsearAjusteWslpg(xml, coe) {
  const definition = solicitudAjusteWslpgPorCoe(coe);
  const error = wslpgBusinessError(xml);
  if (error) throw new Error(error);
  const result = tag(xml, definition.resultTag);
  if (!result) throw new Error(`WSLPG no devolvio datos para el ajuste ${definition.coe}.`);
  const ajuste = tag(result, definition.payloadTag);
  if (!ajuste) throw new Error(`WSLPG no devolvio el ajuste unificado para el COE ${definition.coe}.`);
  return {
    tipoDocumento: 'LPG_AJUSTE',
    fuente: 'WSLPG_AJUSTE_COE',
    coe: tag(ajuste, 'coe') || definition.coe,
    coeAjustado: tag(ajuste, 'coeAjustado') || null,
    estado: tag(ajuste, 'estado'),
    fecha: fechaWslpg(ajuste),
    ptoEmision: Number(tag(ajuste, 'ptoEmision') || 0) || null,
    nroOrden: Number(tag(ajuste, 'nroOrden') || 0) || null,
    nroContrato: tag(ajuste, 'nroContrato') || null,
    pdfBase64: tag(result, 'pdf') || null,
    rawXml: result
  };
}

async function wslpgConsultarAjusteCoe(coe) {
  const definition = solicitudAjusteWslpgPorCoe(coe);
  const xml = await wslpgCall(definition.operation, definition.requestXml);
  return parsearAjusteWslpg(xml, definition.coe);
}

async function importarWslpgAjustesPorCoe(coes) {
  await ensureSyncTables();
  const unicos = [...new Set((Array.isArray(coes) ? coes : [])
    .map(value => String(value || '').replace(/\D/g, ''))
    .filter(value => /^330\d{9}$/.test(value)))];
  if (!unicos.length) throw new Error('Debe indicar al menos un COE de ajuste WSLPG valido.');
  if (unicos.length > 1000) throw new Error('El lote de ajustes no puede superar 1000 COE.');

  const resultados = [];
  for (const coe of unicos) {
    try {
      const document = await wslpgConsultarAjusteCoe(coe);
      const pdfBuffer = decodificarPdfWslpg(document.pdfBase64);
      if (!pdfBuffer) throw new Error('ARCA no devolvio el PDF oficial del ajuste.');
      const persistencia = await guardarDocumentoOficial(
        document.fuente,
        coe,
        document.fecha,
        document,
        pdfBuffer
      );
      resultados.push({
        coe,
        ok: true,
        tipoDocumento: document.tipoDocumento,
        coeAjustado: document.coeAjustado,
        fecha: document.fecha,
        estado: document.estado,
        ptoEmision: document.ptoEmision,
        nroOrden: document.nroOrden,
        nroContrato: document.nroContrato,
        documentId: persistencia.documentId,
        incluyePdf: persistencia.pdfGuardado
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
      const pdfBuffer = decodificarPdfWslpg(document.pdfBase64);
      const persistencia = await guardarDocumentoOficial(
        document.fuente,
        coe,
        document.fecha,
        document,
        pdfBuffer
      );
      resultados.push({
        coe,
        ok: true,
        tipoDocumento: document.tipoDocumento,
        fecha: document.fecha,
        estado: document.estado,
        ptoEmision: document.ptoEmision,
        nroOrden: document.nroOrden,
        documentId: persistencia.documentId,
        incluyePdf: persistencia.pdfGuardado
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

async function ejecutarSyncWslpgPdfPorCoe(jobId, coes) {
  await ensureSyncTables();
  await pool.query(
    "UPDATE arca_sync_jobs SET estado='EJECUTANDO', started_at=NOW() WHERE id=$1",
    [jobId]
  );

  let revisados = 0;
  let importados = 0;
  const errores = [];
  try {
    validateCredentials(getConfig());
    for (const coe of coes) {
      revisados += 1;
      const lote = await importarWslpgPorCoe([coe]);
      const resultado = lote.resultados[0];
      if (resultado?.ok && resultado.incluyePdf) {
        importados += 1;
      } else {
        errores.push({
          coe,
          error: resultado?.error || 'ARCA no devolvió el PDF oficial.'
        });
      }

      if (revisados % 10 === 0 || revisados === coes.length) {
        await pool.query(`
          UPDATE arca_sync_jobs
          SET total_importados=$1, total_revisados=$2
          WHERE id=$3
        `, [importados, revisados, jobId]);
      }
    }

    const estado = importados === coes.length
      ? 'COMPLETADO'
      : (importados > 0 ? 'PARCIAL' : 'ERROR');
    const detalleError = errores.length
      ? JSON.stringify({ total: errores.length, primeros: errores.slice(0, 25) })
      : null;
    await pool.query(`
      UPDATE arca_sync_jobs
      SET estado=$1, total_importados=$2, total_revisados=$3,
          error=$4, finished_at=NOW()
      WHERE id=$5
    `, [estado, importados, revisados, detalleError, jobId]);
  } catch (error) {
    await pool.query(`
      UPDATE arca_sync_jobs
      SET estado='ERROR', total_importados=$1, total_revisados=$2,
          error=$3, finished_at=NOW()
      WHERE id=$4
    `, [importados, revisados, error.message, jobId]);
  }
}

async function iniciarSyncWslpgPdfPorCoe({ coes = [], desde = '2026-01-01', userId = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
    throw new Error('La fecha desde debe usar formato AAAA-MM-DD.');
  }
  const unicos = [...new Set((Array.isArray(coes) ? coes : [])
    .map(value => String(value || '').replace(/\D/g, ''))
    .filter(value => /^\d{12}$/.test(value)))];
  if (!unicos.length) throw new Error('Debe indicar al menos un COE WSLPG válido.');
  if (unicos.length > 2000) throw new Error('El trabajo no puede superar 2000 COE.');
  unicos.forEach(tipoWslpgPorCoe);

  await ensureSyncTables();
  const id = crypto.randomUUID();
  await pool.query(`
    INSERT INTO arca_sync_jobs(id, fuente, desde, estado, solicitado_por)
    VALUES($1,'WSLPG_PDF_COE',$2,'PENDIENTE',$3)
  `, [id, desde, userId]);
  setImmediate(() => {
    void ejecutarSyncWslpgPdfPorCoe(id, unicos);
  });
  return {
    id,
    fuente: 'WSLPG_PDF_COE',
    desde,
    totalCoes: unicos.length,
    documentos: [...new Set(unicos.map(coe => tipoWslpgPorCoe(coe).id))],
    estado: 'PENDIENTE'
  };
}

async function ejecutarSyncWslpgAjustesPorCoe(jobId, coes) {
  await ensureSyncTables();
  await pool.query(
    "UPDATE arca_sync_jobs SET estado='EJECUTANDO', started_at=NOW() WHERE id=$1",
    [jobId]
  );

  let revisados = 0;
  let importados = 0;
  const errores = [];
  try {
    validateCredentials(getConfig());
    for (const coe of coes) {
      revisados += 1;
      const lote = await importarWslpgAjustesPorCoe([coe]);
      const resultado = lote.resultados[0];
      if (resultado?.ok && resultado.incluyePdf) {
        importados += 1;
      } else {
        errores.push({
          coe,
          error: resultado?.error || 'ARCA no devolvio el PDF oficial del ajuste.'
        });
      }

      if (revisados % 10 === 0 || revisados === coes.length) {
        await pool.query(`
          UPDATE arca_sync_jobs
          SET total_importados=$1, total_revisados=$2
          WHERE id=$3
        `, [importados, revisados, jobId]);
      }
    }

    const estado = importados === coes.length
      ? 'COMPLETADO'
      : (importados > 0 ? 'PARCIAL' : 'ERROR');
    const detalleError = errores.length
      ? JSON.stringify({ total: errores.length, primeros: errores.slice(0, 25) })
      : null;
    await pool.query(`
      UPDATE arca_sync_jobs
      SET estado=$1, total_importados=$2, total_revisados=$3,
          error=$4, finished_at=NOW()
      WHERE id=$5
    `, [estado, importados, revisados, detalleError, jobId]);
  } catch (error) {
    await pool.query(`
      UPDATE arca_sync_jobs
      SET estado='ERROR', total_importados=$1, total_revisados=$2,
          error=$3, finished_at=NOW()
      WHERE id=$4
    `, [importados, revisados, error.message, jobId]);
  }
}

async function iniciarSyncWslpgAjustesPorCoe({ coes = [], desde = '2026-01-01', userId = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
    throw new Error('La fecha desde debe usar formato AAAA-MM-DD.');
  }
  const unicos = [...new Set((Array.isArray(coes) ? coes : [])
    .map(value => String(value || '').replace(/\D/g, ''))
    .filter(value => /^330\d{9}$/.test(value)))];
  if (!unicos.length) throw new Error('Debe indicar al menos un COE de ajuste WSLPG valido.');
  if (unicos.length > 2000) throw new Error('El trabajo de ajustes no puede superar 2000 COE.');
  unicos.forEach(solicitudAjusteWslpgPorCoe);

  await ensureSyncTables();
  const id = crypto.randomUUID();
  await pool.query(`
    INSERT INTO arca_sync_jobs(id, fuente, desde, estado, solicitado_por)
    VALUES($1,'WSLPG_AJUSTE_PDF_COE',$2,'PENDIENTE',$3)
  `, [id, desde, userId]);
  setImmediate(() => {
    void ejecutarSyncWslpgAjustesPorCoe(id, unicos);
  });
  return {
    id,
    fuente: 'WSLPG_AJUSTE_PDF_COE',
    desde,
    totalCoes: unicos.length,
    documentos: ['LPG_AJUSTE'],
    estado: 'PENDIENTE'
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

async function ejecutarSyncCpePorCtg(jobId, ctgs, userId = null) {
  await pool.query("UPDATE arca_sync_jobs SET estado='EJECUTANDO', started_at=NOW() WHERE id=$1", [jobId]);
  let revisados = 0;
  let importados = 0;
  const errores = [];
  for (const ctg of ctgs) {
    revisados += 1;
    try {
      await importarCpePorCtg(ctg, { jobId, userId });
      importados += 1;
    } catch (error) {
      errores.push({ ctg, error: error.message });
    }
    await pool.query(`
      UPDATE arca_sync_jobs SET total_importados=$1,total_revisados=$2 WHERE id=$3
    `, [importados, revisados, jobId]);
  }
  const estado = errores.length ? (importados ? 'PARCIAL' : 'ERROR') : 'COMPLETADO';
  await pool.query(`
    UPDATE arca_sync_jobs
    SET estado=$1,total_importados=$2,total_revisados=$3,error=$4,finished_at=NOW()
    WHERE id=$5
  `, [estado, importados, revisados, errores.length ? JSON.stringify(errores).slice(0, 20000) : null, jobId]);
}

async function iniciarSyncCpePorCtg({ ctgs = [], desde = '2026-02-01', userId = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) throw new Error('La fecha desde debe usar formato AAAA-MM-DD.');
  const safeCtgs = [...new Set((Array.isArray(ctgs) ? ctgs : [ctgs])
    .map(value => String(value || '').replace(/\D/g, ''))
    .filter(value => /^\d{8,20}$/.test(value)))];
  if (!safeCtgs.length) throw new Error('Debe indicar al menos un CTG válido.');
  if (safeCtgs.length > 5000) throw new Error('El lote no puede superar 5000 CTG.');
  await ensureSyncTables();
  const id = crypto.randomUUID();
  await pool.query(`
    INSERT INTO arca_sync_jobs(id,fuente,desde,estado,solicitado_por)
    VALUES($1,'WSCPE_CPE',$2,'PENDIENTE',$3)
  `, [id, desde, userId]);
  setImmediate(() => void ejecutarSyncCpePorCtg(id, safeCtgs, userId));
  return { id, fuente: 'WSCPE_CPE', desde, totalCtgs: safeCtgs.length, estado: 'PENDIENTE' };
}

function primerTag(xml, nombres) {
  for (const nombre of nombres) {
    const value = tag(xml || '', nombre);
    if (value !== null && value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return null;
}

function numeroCpe(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits || null;
}

const DERIVADOS_GRANARIOS_ARCA = Object.freeze({
  '101': 'Aceite crudo de girasol',
  '102': 'Aceite crudo de maíz',
  '103': 'Aceite crudo de soja',
  '119': 'Balanceado y/o suplemento granario para aves',
  '120': 'Balanceado y/o suplemento granario para bovinos',
  '121': 'Balanceado y/o suplemento granario para equinos',
  '122': 'Balanceado y/o suplemento granario para otros',
  '123': 'Balanceado y/o suplemento granario para ovinos',
  '124': 'Balanceado y/o suplemento granario para porcinos',
  '125': 'Balanceado y/o suplemento granario para otras especies',
  '136': 'Desechos de arroz',
  '137': 'Desechos de avena',
  '138': 'Desechos de girasol',
  '139': 'Desechos de maíz',
  '140': 'Desechos de soja',
  '141': 'Desechos de sorgo',
  '142': 'Desechos de trigo',
  '144': 'Expeller de girasol',
  '145': 'Expeller de soja',
  '146': 'Extrujado de soja',
  '152': 'Girasol quebrado-partido',
  '187': 'Maíz quebrado-partido',
  '199': 'Pellets de girasol',
  '200': 'Pellets de maíz',
  '201': 'Pellets de soja',
  '202': 'Pellets de sorgo',
  '204': 'Prensado de girasol',
  '205': 'Prensado de soja',
  '218': 'Soja desactivada',
  '219': 'Soja quebrada-partida',
  '220': 'Soja tostada',
  '221': 'Sojilla',
  '222': 'Torta de presión de lino',
  '223': 'Torta de presión de maní',
  '225': 'Torta de presión de colza',
  '226': 'Trigo quebrado-partido',
  '227': 'Triguillo',
  '287': 'Pellets de cebada'
});

const GRANOS_ARCA = Object.freeze({
  '1': 'Lino',
  '2': 'Girasol',
  '16': 'Avena',
  '19': 'Maíz',
  '23': 'Soja',
  '35': 'Arroz',
  '50': 'Otros granos',
  '100': 'Cebada',
  '101': 'Maní',
  '103': 'Trigo',
  '104': 'Sorgo',
  '107': 'Colza'
});

function descripcionEspecificaDerivado(payload = {}) {
  const texto = JSON.stringify(payload || {})
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const reglas = [
    [/pellets? de cascara de soja/, 'Pellets de cáscara de soja'],
    [/cascara de soja/, 'Cáscara de soja'],
    [/harina de soja/, 'Harina de soja'],
    [/aceite crudo de soja/, 'Aceite crudo de soja'],
    [/aceite de soja/, 'Aceite de soja'],
    [/expeller de soja/, 'Expeller de soja'],
    [/extrujado de soja/, 'Extrujado de soja'],
    [/pellets? de soja/, 'Pellets de soja'],
    [/aceite crudo de girasol/, 'Aceite crudo de girasol'],
    [/expeller de girasol/, 'Expeller de girasol'],
    [/pellets? de girasol/, 'Pellets de girasol'],
    [/aceite crudo de maiz/, 'Aceite crudo de maíz'],
    [/pellets? de maiz/, 'Pellets de maíz'],
    [/pellets? de sorgo/, 'Pellets de sorgo'],
    [/pellets? de cebada/, 'Pellets de cebada']
  ];
  return reglas.find(([patron]) => patron.test(texto))?.[1] || null;
}

function textoEscalarOficial(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const texto = textoEscalarOficial(item);
      if (texto) return texto;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const clave of ['_text', 'text', 'value', 'valor']) {
      if (!Object.prototype.hasOwnProperty.call(value, clave)) continue;
      const texto = textoEscalarOficial(value[clave]);
      if (texto) return texto;
    }
    return null;
  }
  const texto = String(value).trim();
  return texto || null;
}

function valorAnidadoPorClaves(value, claves, visitados = new Set()) {
  if (!value || typeof value !== 'object' || visitados.has(value)) return null;
  visitados.add(value);
  const clavesNormalizadas = new Set(claves.map(clave => String(clave).toLowerCase()));
  for (const [clave, contenido] of Object.entries(value)) {
    if (clavesNormalizadas.has(String(clave).toLowerCase())) {
      const texto = textoEscalarOficial(contenido);
      if (texto) return texto;
    }
  }
  for (const contenido of Object.values(value)) {
    if (!contenido || typeof contenido !== 'object') continue;
    const encontrado = valorAnidadoPorClaves(contenido, claves, visitados);
    if (encontrado) return encontrado;
  }
  return null;
}

function productoCpeOficial(tipoCpe, datosCarga = {}, payload = {}, catalogos = {}) {
  const codigoDerivadoAnidado = valorAnidadoPorClaves(payload, [
    'codDerivadoGranario', 'codigoDerivadoGranario', 'codProductoDerivado', 'codigoProductoDerivado'
  ]);
  const descripcionDerivadoAnidada = valorAnidadoPorClaves(payload, [
    'descDerivadoGranario', 'descripcionDerivadoGranario', 'derivadoGranario',
    'descProductoDerivado', 'descripcionProductoDerivado'
  ]);
  const codigoGranoAnidado = valorAnidadoPorClaves(payload, [
    'codGrano', 'codigoGrano', 'codEspecie', 'codigoEspecie', 'codGranoOrigen', 'codigoGranoOrigen'
  ]);
  const descripcionDetectada = descripcionEspecificaDerivado(payload);
  const codigoDerivadoInformado = textoEscalarOficial(
    datosCarga.codDerivadoGranario || datosCarga.codigoDerivadoGranario || codigoDerivadoAnidado
  );
  const esDerivado = /_DG$/i.test(String(tipoCpe || '')) ||
    Boolean(codigoDerivadoInformado) ||
    Boolean(codigoDerivadoAnidado || descripcionDerivadoAnidada || descripcionDetectada);
  const codigoDerivado = codigoDerivadoInformado || '';
  const codigoGrano = textoEscalarOficial(
    datosCarga.codGrano || datosCarga.codigoGrano || codigoGranoAnidado
  ) || '';
  if (esDerivado) {
    const descripcionInformada = textoEscalarOficial(
      datosCarga.descDerivadoGranario ||
      datosCarga.descripcionDerivadoGranario ||
      datosCarga.derivadoGranario ||
      descripcionDerivadoAnidada
    ) || '';
    const nombre = descripcionDetectada ||
      descripcionInformada ||
      catalogos.derivados?.[codigoDerivado] ||
      DERIVADOS_GRANARIOS_ARCA[codigoDerivado] ||
      null;
    const codigoNombre = nombre
      ? crypto.createHash('sha256').update(nombre.toLowerCase()).digest('hex').slice(0, 12).toUpperCase()
      : null;
    return {
      codigo: codigoDerivado ? `ARCA-DG-${codigoDerivado}` : (codigoNombre ? `ARCA-DG-N-${codigoNombre}` : null),
      codigoArca: codigoDerivado || null,
      nombre,
      tipoProducto: 'SUBPRODUCTO',
      codigoGrano: codigoGrano || null,
      esDerivado: true
    };
  }
  return {
    codigo: codigoGrano ? `ARCA-GR-${codigoGrano}` : null,
    codigoArca: codigoGrano || null,
    nombre: catalogos.granos?.[codigoGrano] || GRANOS_ARCA[codigoGrano] || null,
    tipoProducto: 'GRANO',
    codigoGrano: codigoGrano || null,
    esDerivado: false
  };
}

async function asegurarEspecieProductoCpe(client, producto) {
  if (!producto?.codigo || !producto?.nombre) return null;
  const { rows: existente } = await client.query(
    'SELECT id,nombre FROM especies WHERE activa=true AND (codigo=$1 OR lower(nombre)=lower($2)) ORDER BY codigo=$1 DESC LIMIT 1',
    [producto.codigo, producto.nombre]
  );
  if (existente[0]) {
    await client.query(
      `UPDATE especies
       SET tipo_producto=$1,
           codigo=CASE WHEN codigo LIKE 'ARCA-%' OR codigo IS NULL THEN $2 ELSE codigo END,
           activa=true
       WHERE id=$3`,
      [producto.tipoProducto, producto.codigo, existente[0].id]
    );
    return existente[0];
  }

  let idOrigen = null;
  if (producto.esDerivado && producto.codigoGrano) {
    const nombreOrigen = GRANOS_ARCA[producto.codigoGrano] || null;
    const { rows: origen } = await client.query(
      `SELECT id FROM especies
       WHERE activa=true AND (
         codigo=$1 OR codigo=$2 OR lower(nombre)=lower($3)
       ) LIMIT 1`,
      [`ARCA-GR-${producto.codigoGrano}`,
       producto.codigoGrano === '23' ? 'SOJ' : `ARCA-GR-${producto.codigoGrano}`,
       nombreOrigen]
    );
    idOrigen = origen[0]?.id || null;
  }

  const { rows } = await client.query(
    `INSERT INTO especies(nombre,codigo,tipo_producto,id_especie_origen,activa)
     VALUES($1,$2,$3,$4,true)
     ON CONFLICT(codigo) DO UPDATE SET
       nombre=EXCLUDED.nombre,
       tipo_producto=EXCLUDED.tipo_producto,
       id_especie_origen=COALESCE(especies.id_especie_origen,EXCLUDED.id_especie_origen),
       activa=true
     RETURNING id,nombre`,
    [producto.nombre, producto.codigo, producto.tipoProducto, idOrigen]
  );
  return rows[0] || null;
}

async function materializarMovimientosCpe({ desde = '2026-02-01', userId = null, soloConfirmadas = true, ctgs = null } = {}) {
  const ctgsFiltrados = Array.isArray(ctgs)
    ? [...new Set(ctgs.map(value => String(value || '').replace(/\D/g, '')).filter(value => /^\d{8,20}$/.test(value)))]
    : null;
  const fechaDesde = validarFechaIso(desde, 'La fecha desde');
  const catalogos = { granos: {}, derivados: {} };
  try {
    const [granos, derivados] = await Promise.all([
      consultarTiposGranoWscpe(),
      consultarDerivadosGranariosWscpe().catch(error => {
        console.warn('Catálogo de derivados ARCA no disponible; se conserva el catálogo local:', error.message);
        return [];
      })
    ]);
    catalogos.granos = Object.fromEntries(granos.map(item => [item.codigo, item.descripcion]));
    catalogos.derivados = Object.fromEntries(derivados.map(item => [item.codigo, item.descripcion]));
  } catch (error) {
    console.warn('Catálogo de granos ARCA no disponible; se conserva el catálogo local:', error.message);
  }
  await ensureCpeMasterTables();
  // La clasificación oficial SUBPRODUCTO requiere 11 caracteres; la columna histórica tenía 10.
  await pool.query(`
    ALTER TABLE especies ALTER COLUMN tipo_producto TYPE VARCHAR(20);
    ALTER TABLE especies ALTER COLUMN codigo TYPE VARCHAR(30);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS arca_cpe_movement_links (
      ctg VARCHAR(20) PRIMARY KEY REFERENCES arca_cpe_registry(ctg) ON DELETE RESTRICT,
      document_id BIGINT NOT NULL REFERENCES arca_official_documents(id) ON DELETE RESTRICT,
      movimiento_id INTEGER NOT NULL UNIQUE REFERENCES movimientos(id) ON DELETE RESTRICT,
      created_by INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS arca_cpe_movement_pending (
      ctg VARCHAR(20) PRIMARY KEY REFERENCES arca_cpe_registry(ctg) ON DELETE CASCADE,
      document_id BIGINT NOT NULL REFERENCES arca_official_documents(id) ON DELETE CASCADE,
      motivos JSONB NOT NULL DEFAULT '[]'::jsonb,
      payload_hash VARCHAR(64),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const client = await pool.connect();
  const resultado = {
    revisadas: 0,
    confirmadas: 0,
    omitidasNoConfirmadas: 0,
    creadas: 0,
    existentes: 0,
    pendientes: 0,
    detallePendientes: []
  };
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('granosys:arca-cpe-movimientos'))");
    const { rows: documentos } = await client.query(`
      SELECT r.ctg, r.tipo_cpe, d.id AS document_id,
             COALESCE(d.document_date, (
               SELECT MIN(c.fecha_emision) FROM certificado_1116_ctgs cc
               JOIN certificados_1116 c ON c.id=cc.id_certificado_1116
               WHERE cc.cpe_document_id=d.id
             )) AS document_date,
             d.payload, d.payload_hash,
             COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM arca_cpe_participants p WHERE p.document_id=d.id), '[]'::jsonb) participantes,
             COALESCE((SELECT jsonb_agg(to_jsonb(pl) ORDER BY pl.id) FROM arca_cpe_plants pl WHERE pl.document_id=d.id), '[]'::jsonb) plantas
      FROM arca_cpe_registry r
      JOIN arca_official_documents d ON d.id=r.document_id
      WHERE r.ctg ~ '^[0-9]{8,20}
    `, [fechaDesde, ctgsFiltrados?.length ? ctgsFiltrados : null]);

    const { rows: secuencia } = await client.query(`
      SELECT COALESCE(MAX((regexp_match(numero_movimiento, '^MOV-([0-9]+)$'))[1]::bigint),0) AS ultimo
      FROM movimientos WHERE numero_movimiento ~ '^MOV-[0-9]+$'
    `);
    let siguiente = Number(secuencia[0]?.ultimo || 0) + 1;

    const pickRol = (items, patrones) => items.find(item => patrones.some(pattern => pattern.test(String(item.rol || '')))) || null;
    resultado.actualizadas = 0;
    for (const doc of documentos) {
      resultado.revisadas += 1;
      const payload = doc.payload || {};
      const rawXml = String(payload.rawXml || payload.raw_xml || '');
      const estadoOficial = estadoCpeDesdePayload(payload);
      if (soloConfirmadas && !esEstadoConfirmadoCpe(estadoOficial)) {
        resultado.omitidasNoConfirmadas += 1;
        continue;
      }
      resultado.confirmadas += 1;
      const datosCarga = payload.datosCarga || payload.datos_carga || {};
      const cabecera = payload.cabecera || {};
      const transporte = payload.transporte || {};
      if (!datosCarga.codGrano) {
        datosCarga.codGrano = primerTag(rawXml, ['codGrano', 'codigoGrano', 'codEspecie', 'codigoEspecie']);
      }
      if (!datosCarga.codDerivadoGranario) {
        datosCarga.codDerivadoGranario = primerTag(rawXml, ['codDerivadoGranario', 'codigoDerivadoGranario']);
      }
      const producto = productoCpeOficial(doc.tipo_cpe, datosCarga, payload, catalogos);
      const especie = await asegurarEspecieProductoCpe(client, producto);
      const participantes = Array.isArray(doc.participantes) ? doc.participantes : [];
      const plantas = Array.isArray(doc.plantas) ? doc.plantas : [];
      const plantaOrigen = plantas.find(item => /ORIGEN/i.test(String(item.rol || ''))) || null;
      const clasificacionOrigen = clasificarOrigenCtg(doc.ctg);

      const { rows: ya } = await client.query('SELECT id,id_especie,observaciones FROM movimientos WHERE nro_ctg=$1 LIMIT 1', [doc.ctg]);
      if (ya[0]) {
        await client.query(`
          UPDATE movimientos SET
            tipo_origen_cpe=COALESCE($1,tipo_origen_cpe),
            origen_produccion=COALESCE($2,origen_produccion),
            nro_planta_origen=COALESCE($3,nro_planta_origen),
            id_ubicacion_origen=COALESCE($4,id_ubicacion_origen)
          WHERE id=$5
        `, [clasificacionOrigen.tipoOrigenCpe, clasificacionOrigen.origenProduccion,
          plantaOrigen?.nro_planta || null, plantaOrigen?.ubicacion_id || null, ya[0].id]);
        if (especie && Number(ya[0].id_especie) !== Number(especie.id)) {
          const notaProducto = `Producto ARCA: ${producto.nombre} (código ${producto.codigoArca}).`;
          const observacionActual = String(ya[0].observaciones || '')
            .replace(/\s*Producto ARCA:[^.]*\./gi, '')
            .trim();
          await client.query(
            'UPDATE movimientos SET id_especie=$1,observaciones=$2 WHERE id=$3',
            [especie.id, `${observacionActual} ${notaProducto}`.trim(), ya[0].id]
          );
          resultado.actualizadas += 1;
        }
        await client.query(`INSERT INTO arca_cpe_movement_links(ctg,document_id,movimiento_id,created_by)
          VALUES($1,$2,$3,$4) ON CONFLICT(ctg) DO NOTHING`, [doc.ctg, doc.document_id, ya[0].id, userId]);
        await client.query('DELETE FROM arca_cpe_movement_pending WHERE ctg=$1', [doc.ctg]);
        resultado.existentes += 1;
        continue;
      }
      const motivos = [];
      if (!doc.document_date) motivos.push('FECHA_CPE_FALTANTE');
      if (!especie) motivos.push(producto.esDerivado ? 'DERIVADO_SIN_MAPEO' : 'ESPECIE_SIN_MAPEO');
      if (motivos.length) {
        await client.query(`INSERT INTO arca_cpe_movement_pending(ctg,document_id,motivos,payload_hash)
          VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(ctg) DO UPDATE SET document_id=EXCLUDED.document_id,motivos=EXCLUDED.motivos,payload_hash=EXCLUDED.payload_hash,updated_at=NOW()`,
          [doc.ctg, doc.document_id, JSON.stringify(motivos), doc.payload_hash]);
        resultado.pendientes += 1;
        if (resultado.detallePendientes.length < 50) resultado.detallePendientes.push({ ctg: doc.ctg, motivos });
        continue;
      }

      const persona = item => ({ cuit: item?.cuit || null, nombre: item?.razon_social_oficial || null });
      const titular = persona(pickRol(participantes, [/SOLICITANTE/i, /TITULAR/i, /^ORIGEN$/i]));
      const remitente = persona(pickRol(participantes, [/REMITENTE_COMERCIAL_VENTA_PRIMARIA/i, /^REMITENTE_COMERCIAL$/i, /^ORIGEN$/i]));
      const remitenteVenta = persona(pickRol(participantes, [/REMITENTE_COMERCIAL_VENTA_PRIMARIA/i]));
      const destinatario = persona(pickRol(participantes, [/^DESTINATARIO$/i]));
      const destino = persona(pickRol(participantes, [/^DESTINO$/i, /TITULAR_PLANTA/i]));
      const pagador = persona(pickRol(participantes, [/PAGADOR_FLETE/i]));
      const plantaDestino = plantas.find(item => /DESTINO/i.test(String(item.rol || ''))) || null;
      const bruto = Number(datosCarga.pesoBruto || datosCarga.pesoBrutoOrigen || primerTag(rawXml, ['pesoBruto', 'pesoBrutoOrigen', 'pesoBrutoSalida']) || 0) || null;
      const tara = Number(datosCarga.pesoTara || datosCarga.tara || primerTag(rawXml, ['pesoTara', 'tara', 'pesoTaraOrigen']) || 0) || null;
      const neto = Number(datosCarga.pesoNeto || datosCarga.pesoNetoCarga || primerTag(rawXml, ['pesoNeto', 'pesoNetoCarga', 'pesoNetoOrigen', 'kilosNetos']) || 0) || (bruto && tara ? bruto - tara : null);
      const estadoArca = String(cabecera.estado || primerTag(rawXml, ['estado', 'estadoCartaPorte']) || '');
      const estado = /ANUL/i.test(estadoArca) ? 'ANULADO' : /RECHAZ/i.test(estadoArca) ? 'RECHAZADO' : 'EN_TRANSITO';
      const numeroMovimiento = `MOV-${String(siguiente++).padStart(4, '0')}`;
      const { rows: creadas } = await client.query(`
        INSERT INTO movimientos(
          numero_movimiento,modalidad,estado,estado_liquidacion,nro_cpe,nro_ctg,fecha_cpe,
          titular_cpe_cuit,titular_cpe_nombre,remitente_comercial_productor_cuit,remitente_comercial_productor_nombre,
          rte_comercial_venta_primaria_cuit,rte_comercial_venta_primaria_nombre,destinatario_cuit,destinatario_nombre,
          destino_cuit,destino_nombre,flete_pagador_cuit,flete_pagador_nombre,id_especie,
          localidad_origen,provincia_origen,nro_planta_origen,nro_planta_destino,localidad_destino,provincia_destino,
          id_ubicacion_origen,id_ubicacion_destino,tipo_origen_cpe,origen_produccion,
          patente_chasis,patente_acoplado,fecha_partida,km_a_recorrer,
          peso_bruto_salida_kg,peso_tara_salida_kg,peso_neto_salida_kg,observaciones,usuario_carga
        ) VALUES($1,'FORMAL',$2,'SIN_ASIGNAR',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
          $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37) RETURNING id
      `, [numeroMovimiento,estado,numeroCpe(primerTag(rawXml,['nroCartaPorte','nroCPE','numeroCartaPorte'])),doc.ctg,doc.document_date,
        titular.cuit,titular.nombre,remitente.cuit,remitente.nombre,remitenteVenta.cuit,remitenteVenta.nombre,
        destinatario.cuit,destinatario.nombre,destino.cuit,destino.nombre,pagador.cuit,pagador.nombre,especie.id,
        plantaOrigen?.localidad||null,plantaOrigen?.provincia||null,plantaOrigen?.nro_planta||null,
        plantaDestino?.nro_planta||null,plantaDestino?.localidad||null,plantaDestino?.provincia||null,
        plantaOrigen?.ubicacion_id||null,plantaDestino?.ubicacion_id||null,
        clasificacionOrigen.tipoOrigenCpe,clasificacionOrigen.origenProduccion,
        transporte.dominio||transporte.patenteChasis||primerTag(rawXml,['patenteChasis','dominioAutomotor','patenteCamion']),
        transporte.dominioAcoplado||transporte.patenteAcoplado||primerTag(rawXml,['patenteAcoplado','dominioAcoplado']),
        transporte.fechaHoraPartida||transporte.fechaPartida||primerTag(rawXml,['fechaPartida','fechaInicioViaje']),
        Number(transporte.kmRecorrer||transporte.kilometros||primerTag(rawXml,['kmRecorrer','kilometros','distanciaKm'])||0)||null,bruto,tara,neto,
        `Importado de ARCA ${doc.tipo_cpe}; CTG ${doc.ctg}. Documento oficial ${doc.document_id}.`,userId]);
      await client.query(`INSERT INTO arca_cpe_movement_links(ctg,document_id,movimiento_id,created_by) VALUES($1,$2,$3,$4)`, [doc.ctg,doc.document_id,creadas[0].id,userId]);
      await client.query('DELETE FROM arca_cpe_movement_pending WHERE ctg=$1', [doc.ctg]);
      resultado.creadas += 1;
    }
    await client.query('COMMIT');
    return resultado;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function camposEscalaresDiagnostico(value, path = '', salida = [], visitados = new Set()) {
  if (value === null || value === undefined || salida.length >= 300 || visitados.has(value)) return salida;
  if (typeof value === 'object') {
    visitados.add(value);
    for (const [clave, contenido] of Object.entries(value)) {
      if (/rawxml|raw_xml|pdf|token|sign|cert|key/i.test(clave)) continue;
      camposEscalaresDiagnostico(contenido, path ? `${path}.${clave}` : clave, salida, visitados);
    }
    return salida;
  }
  const texto = String(value).trim();
  if (!texto || texto.length > 120 || /^\d{11,20}$/.test(texto)) return salida;
  salida.push({ path, value: texto });
  return salida;
}

async function diagnosticarDerivadosPendientes() {
  const { rows } = await pool.query(`
    SELECT p.ctg,d.payload
    FROM arca_cpe_movement_pending p
    JOIN arca_official_documents d ON d.id=p.document_id
    WHERE p.motivos @> '["DERIVADO_SIN_MAPEO"]'::jsonb
    ORDER BY p.ctg LIMIT 5
  `);
  return rows.map(row => ({
    ctg: row.ctg,
    campos: camposEscalaresDiagnostico(row.payload).filter(item =>
      /producto|grano|deriv|mercader|especie|carga|cod|desc/i.test(item.path)
    )
  }));
}

async function listarReporteCpeCertificados() {
  const cuitInversiones = '30710183992';
  const { rows: certificadosRows } = await pool.query(`
    SELECT c.id,c.coe,c.numero_certificado,c.fecha_emision,
      c.kilos_netos_acondicionados,
      COUNT(cc.id)::int AS total_ctgs,
      COUNT(cc.id) FILTER (WHERE cc.cpe_document_id IS NOT NULL)::int AS ctgs_vinculados,
      COALESCE(SUM(cc.kg_netos_acondicionados)
        FILTER (WHERE cc.cpe_document_id IS NOT NULL),0) AS kilos_asignados
    FROM certificados_1116 c
    LEFT JOIN certificado_1116_ctgs cc ON cc.id_certificado_1116=c.id
    GROUP BY c.id,c.coe,c.numero_certificado,c.fecha_emision,c.kilos_netos_acondicionados
    ORDER BY c.fecha_emision,c.coe,c.id
  `);
  const certificados = certificadosRows.map(row => {
    const totalCtgs=Number(row.total_ctgs||0);
    const ctgsVinculados=Number(row.ctgs_vinculados||0);
    const kilosCertificados=row.kilos_netos_acondicionados==null?null:Number(row.kilos_netos_acondicionados);
    const kilosAsignados=Number(row.kilos_asignados||0);
    return {
      id:row.id,
      coe:row.coe,
      numeroCertificado:row.numero_certificado,
      fecha:row.fecha_emision,
      totalCtgs,
      ctgsVinculados,
      estado:totalCtgs===0?'SIN_CTG':ctgsVinculados===totalCtgs?'COMPLETO':ctgsVinculados>0?'PARCIAL':'PENDIENTE',
      kilosCertificados,
      kilosAsignados,
      saldoKilos:kilosCertificados==null?null:kilosCertificados-kilosAsignados
    };
  });
  const certificadosConKilos=certificados.filter(item=>item.kilosCertificados!=null);
  const resumenCertificados = {
    total:certificados.length,
    completos:certificados.filter(item=>item.estado==='COMPLETO').length,
    parciales:certificados.filter(item=>item.estado==='PARCIAL').length,
    pendientes:certificados.filter(item=>item.estado==='PENDIENTE').length,
    sinCtg:certificados.filter(item=>item.estado==='SIN_CTG').length,
    kilosCertificados:certificadosConKilos.reduce((s,item)=>s+item.kilosCertificados,0),
    kilosAsignados:certificados.reduce((s,item)=>s+item.kilosAsignados,0),
    saldoKilos:certificadosConKilos.reduce((s,item)=>s+item.saldoKilos,0),
    sinKilos:certificados.length-certificadosConKilos.length
  };
  const { rows } = await pool.query(`
    SELECT r.ctg,d.document_date,
      COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
        'rol',p.rol,'cuit',p.cuit,'nombre',p.razon_social_oficial
      )) FILTER (WHERE p.id IS NOT NULL),'[]'::jsonb) AS participantes,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'rol',pl.rol,'planta',pl.nro_planta,'cuit',pl.cuit_titular,
        'nombre',pl.nombre_oficial,'localidad',pl.localidad,'provincia',pl.provincia
      ) ORDER BY pl.rol,pl.nro_planta) FROM arca_cpe_plants pl
        WHERE pl.document_id=r.document_id),'[]'::jsonb) AS plantas,
      COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object(
        'coe',l.certificado_coe,'estado',l.estado
      )) FROM arca_certificado_ctg_links l WHERE l.ctg=r.ctg AND l.cpe_document_id=r.document_id),'[]'::jsonb) AS certificados
    FROM arca_cpe_registry r
    JOIN arca_official_documents d ON d.id=r.document_id
    JOIN arca_cpe_participants objetivo
      ON objetivo.document_id=r.document_id AND objetivo.cuit=$1
    LEFT JOIN arca_cpe_participants p ON p.document_id=r.document_id
    WHERE r.ctg LIKE '101%'
    GROUP BY r.ctg,r.document_id,d.document_date
    ORDER BY r.ctg
  `, [cuitInversiones]);

  const rolesInteres = /^(ORIGEN|SOLICITANTE|TITULAR_PLANTA|DESTINO|DESTINATARIO|REMITENTE_COMERCIAL(?:_VENTA_(?:PRIMARIA|SECUNDARIA)(?:_2)?)?)$/;
  const detalle = rows.map(row => {
    const intervinientes=(row.participantes || []).filter(item => rolesInteres.test(String(item.rol || '')));
    const origenPropio=intervinientes.some(p=>p.rol==='ORIGEN'&&p.cuit===cuitInversiones);
    const destinoPropio=intervinientes.some(p=>/^(DESTINO|DESTINATARIO)$/.test(p.rol)&&p.cuit===cuitInversiones);
    const certificados=row.certificados||[];
    return {
      ctg:row.ctg,
      fecha:row.document_date,
      estadoCertificado:certificados.length?'VINCULADO':'SIN_CERTIFICADO',
      clasificacion:origenPropio&&destinoPropio?'TRASLADO_PROPIO':destinoPropio?'TERCERO_A_PLANTA_PROPIA':'REVISAR',
      intervinientes,
      plantas:row.plantas||[],
      certificados
    };
  });
  return {
    resumen:{
      total:detalle.length,
      vinculadas:detalle.filter(item=>item.estadoCertificado==='VINCULADO').length,
      sinCertificado:detalle.filter(item=>item.estadoCertificado==='SIN_CERTIFICADO').length,
      trasladosPropiosSinCertificado:detalle.filter(item=>item.estadoCertificado==='SIN_CERTIFICADO'&&item.clasificacion==='TRASLADO_PROPIO').length,
      tercerosSinCertificado:detalle.filter(item=>item.estadoCertificado==='SIN_CERTIFICADO'&&item.clasificacion==='TERCERO_A_PLANTA_PROPIA').length
    },
    detalle,
    resumenCertificados,
    certificados
  };
}

function seleccionarPersonaReporte(intervinientes = [], roles = []) {
  for (const rol of roles) {
    const persona = intervinientes.find(item => String(item.rol || '').toUpperCase() === rol);
    if (persona) return persona;
  }
  return null;
}

// Reporte operativo completo para exportar CPE/CPEDG. Es solo lectura y usa
// las tablas normalizadas para no depender de la forma interna del XML de ARCA.
async function listarReporteCpeIntervinientes() {
  await ensureCpeMasterTables();
  const { rows } = await pool.query(`
    SELECT r.ctg,r.tipo_cpe,d.document_date,d.payload,d.payload_hash,
      m.numero_movimiento,m.estado AS estado_movimiento,
      m.peso_bruto_salida_kg,m.peso_tara_salida_kg,m.peso_neto_salida_kg,
      m.patente_chasis,m.patente_acoplado,m.fecha_partida,m.km_a_recorrer,
      e.nombre AS producto_nombre,e.codigo AS producto_codigo,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'rol',p.rol,'cuit',p.cuit,
        'nombre',COALESCE(p.razon_social_oficial,c.razon_social),
        'contraparteId',p.contraparte_id
      ) ORDER BY p.rol,p.cuit)
        FROM arca_cpe_participants p
        LEFT JOIN contrapartes c ON c.id=p.contraparte_id
        WHERE p.document_id=r.document_id),'[]'::jsonb) AS intervinientes,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'rol',pl.rol,'planta',pl.nro_planta,'cuitTitular',pl.cuit_titular,
        'nombre',pl.nombre_oficial,'localidad',pl.localidad,
        'provincia',pl.provincia,'direccion',pl.direccion
      ) ORDER BY pl.rol,pl.nro_planta)
        FROM arca_cpe_plants pl WHERE pl.document_id=r.document_id),'[]'::jsonb) AS plantas,
      COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object(
        'coe',l.certificado_coe,'estado',l.estado
      )) FROM arca_certificado_ctg_links l
        WHERE l.ctg=r.ctg AND l.cpe_document_id=r.document_id),'[]'::jsonb) AS certificados
    FROM arca_cpe_registry r
    JOIN arca_official_documents d ON d.id=r.document_id
    LEFT JOIN arca_cpe_movement_links ml ON ml.ctg=r.ctg
    LEFT JOIN movimientos m ON m.id=ml.movimiento_id
    LEFT JOIN especies e ON e.id=m.id_especie
    ORDER BY d.document_date,r.ctg
  `);

  const detalle = rows.map(row => {
    const payload = row.payload || {};
    const intervinientes = Array.isArray(row.intervinientes) ? row.intervinientes : [];
    const datosCarga = payload.datosCarga || payload.datos_carga || {};
    const producto = productoCpeOficial(row.tipo_cpe, datosCarga, payload);
    const comprador = seleccionarPersonaReporte(intervinientes, [
      'COMPRADOR','DESTINATARIO','DESTINO','REMITENTE_COMERCIAL_VENTA_PRIMARIA'
    ]);
    const vendedor = seleccionarPersonaReporte(intervinientes, [
      'VENDEDOR','REMITENTE_COMERCIAL','ORIGEN','SOLICITANTE'
    ]);
    const transporte = payload.transporte || {};
    const rawXml = String(payload.rawXml || payload.raw_xml || '');
    const numero = value => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
    };
    const bruto = numero(row.peso_bruto_salida_kg)
      || numero(valorAnidadoPorClaves(payload, ['pesoBruto','pesoBrutoOrigen','pesoBrutoSalida']))
      || numero(primerTag(rawXml, ['pesoBruto','pesoBrutoOrigen','pesoBrutoSalida']));
    const tara = numero(row.peso_tara_salida_kg)
      || numero(valorAnidadoPorClaves(payload, ['pesoTara','tara','pesoTaraOrigen']))
      || numero(primerTag(rawXml, ['pesoTara','tara','pesoTaraOrigen']));
    const neto = numero(row.peso_neto_salida_kg)
      || numero(valorAnidadoPorClaves(payload, ['pesoNeto','pesoNetoCarga','pesoNetoOrigen','kilosNetos']))
      || numero(primerTag(rawXml, ['pesoNeto','pesoNetoCarga','pesoNetoOrigen','kilosNetos']))
      || (bruto && tara ? bruto - tara : null);
    return {
      ctg: row.ctg,
      fecha: row.document_date,
      tipoCpe: row.tipo_cpe,
      estadoArca: estadoCpeDesdePayload(payload) || null,
      producto: row.producto_nombre || producto.nombre || null,
      codigoProducto: producto.codigoArca || row.producto_codigo || null,
      pesoBrutoKg: bruto,
      taraKg: tara,
      pesoNetoKg: neto,
      patenteChasis: row.patente_chasis || transporte.dominio || transporte.patenteChasis
        || primerTag(rawXml, ['patenteChasis','dominioAutomotor','patenteCamion']) || null,
      patenteAcoplado: row.patente_acoplado || transporte.dominioAcoplado || transporte.patenteAcoplado
        || primerTag(rawXml, ['patenteAcoplado','dominioAcoplado']) || null,
      fechaPartida: row.fecha_partida || transporte.fechaHoraPartida || transporte.fechaPartida || null,
      kilometros: numero(row.km_a_recorrer) || numero(transporte.kmRecorrer || transporte.kilometros),
      numeroMovimiento: row.numero_movimiento || null,
      estadoMovimiento: row.estado_movimiento || null,
      comprador,
      vendedor,
      intervinientes,
      plantas: Array.isArray(row.plantas) ? row.plantas : [],
      certificados: Array.isArray(row.certificados) ? row.certificados : [],
      payloadHash: row.payload_hash
    };
  });
  return {
    total: detalle.length,
    conCompradorIdentificado: detalle.filter(item => item.comprador).length,
    conCertificado: detalle.filter(item => item.certificados.length > 0).length,
    detalle
  };
}

async function iniciarRefreshDerivadosPendientes() {
  const { rows } = await pool.query(`
    SELECT ctg FROM arca_cpe_movement_pending
    WHERE motivos @> '["DERIVADO_SIN_MAPEO"]'::jsonb ORDER BY ctg
  `);
  const ctgs = rows.map(row => row.ctg);
  if (!ctgs.length) return null;
  return iniciarSyncCpePorCtg({ ctgs, desde: '2026-02-01' });
}

async function ejecutarSyncCpeDestino(jobId, { desde, hasta, userId = null, soloConfirmadas = true }) {
  await pool.query("UPDATE arca_sync_jobs SET estado='EJECUTANDO', started_at=NOW() WHERE id=$1", [jobId]);
  const errores = [];
  let importados = 0;
  let revisados = 0;
  let listados = 0;
  let omitidosNoConfirmados = 0;
  try {
    const config = getConfig();
    const plantas = await consultarPlantasWscpe(config.cuit);
    if (!plantas.length) {
      throw new Error(`ARCA no informo plantas activas para el CUIT ${config.cuit}.`);
    }

    const ctgs = new Set();
    for (const planta of plantas) {
      for (const rango of rangosWscpe(desde, hasta)) {
        try {
          const cartas = await consultarCpesDestinoWscpe({
            planta: planta.nroPlanta,
            desde: rango.desde,
            hasta: rango.hasta
          });
          listados += cartas.length;
          cartas.forEach(item => {
            if (soloConfirmadas && !esEstadoConfirmadoCpe(item.estado)) {
              omitidosNoConfirmados += 1;
              return;
            }
            ctgs.add(item.ctg);
          });
        } catch (error) {
          errores.push({
            fase: 'LISTADO',
            planta: planta.nroPlanta,
            desde: rango.desde,
            hasta: rango.hasta,
            error: error.message
          });
        }
      }
    }

    for (const ctg of ctgs) {
      revisados += 1;
      try {
        await importarCpePorCtg(ctg, { jobId, userId });
        importados += 1;
      } catch (error) {
        errores.push({ fase: 'DETALLE', ctg, error: error.message });
      }
      await pool.query(`
        UPDATE arca_sync_jobs SET total_importados=$1,total_revisados=$2 WHERE id=$3
      `, [importados, revisados, jobId]);
    }

    const estado = errores.length ? (importados ? 'PARCIAL' : 'ERROR') : 'COMPLETADO';
    const resumen = {
      listados,
      ctgConfirmadosUnicos: ctgs.size,
      omitidosNoConfirmados,
      errores
    };
    await pool.query(`
      UPDATE arca_sync_jobs
      SET estado=$1,total_importados=$2,total_revisados=$3,error=$4,finished_at=NOW()
      WHERE id=$5
    `, [estado, importados, revisados, JSON.stringify(resumen).slice(0, 20000), jobId]);
  } catch (error) {
    await pool.query(`
      UPDATE arca_sync_jobs
      SET estado='ERROR',total_importados=$1,total_revisados=$2,error=$3,finished_at=NOW()
      WHERE id=$4
    `, [importados, revisados, error.message, jobId]);
  }
}

async function iniciarSyncCpeDestino({
  desde = '2026-02-01',
  hasta = new Date().toISOString().slice(0, 10),
  userId = null,
  soloConfirmadas = true
} = {}) {
  const fechaDesde = validarFechaIso(desde, 'La fecha desde');
  const fechaHasta = validarFechaIso(hasta, 'La fecha hasta');
  if (fechaDesde > fechaHasta) throw new Error('La fecha desde no puede ser posterior a la fecha hasta.');
  await ensureSyncTables();
  const id = crypto.randomUUID();
  await pool.query(`
    INSERT INTO arca_sync_jobs(id,fuente,desde,estado,solicitado_por)
    VALUES($1,'WSCPE_DESTINO',$2,'PENDIENTE',$3)
  `, [id, fechaDesde, userId]);
  setImmediate(() => void ejecutarSyncCpeDestino(id, {
    desde: fechaDesde,
    hasta: fechaHasta,
    userId,
    soloConfirmadas
  }));
  return {
    id,
    fuente: 'WSCPE_DESTINO',
    desde: fechaDesde,
    hasta: fechaHasta,
    estado: 'PENDIENTE',
    soloConfirmadas
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

function camposOficialesVisibles(value, path = '', salida = [], visitados = new Set()) {
  if (value === null || value === undefined || salida.length >= 500) return salida;
  if (typeof value === 'object') {
    if (visitados.has(value)) return salida;
    visitados.add(value);
    for (const [clave, contenido] of Object.entries(value)) {
      if (/rawxml|raw_xml|pdf|token|sign|firma|certificado_pem|private.?key/i.test(clave)) continue;
      camposOficialesVisibles(contenido, path ? `${path}.${clave}` : clave, salida, visitados);
    }
    return salida;
  }
  const texto = String(value).trim();
  if (texto && texto.length <= 500) salida.push({ campo: path, valor: value });
  return salida;
}

function camposXmlOficiales(xml) {
  const salida = [];
  const pila = [];
  const ocurrencias = new Map();
  const sensible = /^(?:pdf|token|sign|firma|certificado(?:_?pem)?|private.?key)$/i;
  const tokens = String(xml || '').match(/<[^>]+>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!')) continue;
    const cierre = token.match(/^<\/(?:[\w.-]+:)?([\w.-]+)\s*>$/);
    if (cierre) {
      const indice = pila.map(item => item.nombre.toLowerCase()).lastIndexOf(cierre[1].toLowerCase());
      if (indice >= 0) pila.splice(indice);
      continue;
    }
    const apertura = token.match(/^<(?:[\w.-]+:)?([\w.-]+)(?:\s[^>]*)?>$/);
    if (apertura && !/\/\s*>$/.test(token)) {
      const padre = pila.map(item => `${item.nombre}[${item.indice}]`).join('.');
      const clave = `${padre}/${apertura[1].toLowerCase()}`;
      const indice = (ocurrencias.get(clave) || 0) + 1;
      ocurrencias.set(clave, indice);
      pila.push({ nombre: apertura[1], indice });
      continue;
    }
    if (token.startsWith('<') || !pila.length || pila.some(item => sensible.test(item.nombre))) continue;
    const valor = decodeXml(token).replace(/\s+/g, ' ').trim();
    if (valor && valor.length <= 500) salida.push({ campo: pila.map(item => `${item.nombre}[${item.indice}]`).join('.'), valor });
  }
  return salida;
}

function detalleLiquidacionWslpg(payload = {}) {
  const rawXml = String(payload.rawXml || payload.raw_xml || '');
  const { rawXml: omitidoRawXml, raw_xml: omitidoRawXmlAlternativo, ...payloadPublico } = payload;
  void omitidoRawXml;
  void omitidoRawXmlAlternativo;
  const camposPayload = camposOficialesVisibles(payloadPublico);
  const camposXml = camposXmlOficiales(rawXml);
  const campos = [...camposXml, ...camposPayload];
  const normalizar = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const nombreCampo = campo => String(campo || '').split('.').pop().replace(/\[\d+\]$/,'');
  const encontrarEn = (coleccion, aliases) => {
    const buscados = aliases.map(normalizar);
    const exacto = coleccion.find(item => buscados.includes(normalizar(nombreCampo(item.campo))));
    return exacto ? exacto.valor : null;
  };
  const encontrar = aliases => encontrarEn(camposXml, aliases) ?? encontrarEn(camposPayload, aliases);
  const parsearNumero = value => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    let texto = String(value).trim().replace(/[^0-9,.-]/g, '');
    if (!texto || !/[0-9]/.test(texto)) return null;
    const ultimaComa = texto.lastIndexOf(',');
    const ultimoPunto = texto.lastIndexOf('.');
    if (ultimaComa >= 0 && ultimoPunto >= 0) {
      const decimal = ultimaComa > ultimoPunto ? ',' : '.';
      texto = texto.replace(decimal === ',' ? /\./g : /,/g, '').replace(decimal, '.');
    } else if (ultimaComa >= 0) {
      texto = texto.replace(/\./g, '').replace(',', '.');
    } else if ((texto.match(/\./g) || []).length > 1) {
      const partes = texto.split('.');
      texto = `${partes.slice(0, -1).join('')}.${partes.at(-1)}`;
    }
    const parsed = Number(texto);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const numero = aliases => {
    return parsearNumero(encontrar(aliases));
  };
  const agruparPorPadre = coleccion => {
    const grupos = new Map();
    for (const item of coleccion) {
      const partes = item.campo.split('.');
      const clave = partes.slice(0, -1).join('.') || 'raiz';
      if (!grupos.has(clave)) grupos.set(clave, []);
      grupos.get(clave).push({ ...item, nombre: nombreCampo(partes.at(-1)) });
    }
    return [...grupos.entries()].map(([ruta, valores]) => ({ ruta, valores }));
  };
  const valorGrupo = (grupo, aliases) => encontrarEn(grupo.valores.map(item => ({ campo: item.nombre, valor: item.valor })), aliases);
  const grupos = agruparPorPadre(camposXml);
  const conceptosImpositivos = grupos.map(grupo => {
    const ruta = normalizar(grupo.ruta);
    const descripcion = valorGrupo(grupo, ['descripcion','detalle','concepto','tipoRetencion','tipoImpuesto']);
    const importe = parsearNumero(valorGrupo(grupo, ['importe','monto','importeRetencion','importeImpuesto','importeTributo','importeIva']));
    const esImpositivo = /iva|retenc|percepc|ganancia|sello|tribut|comision|ingresosbrutos|suss/.test(ruta + normalizar(descripcion));
    if (!esImpositivo || importe === null) return null;
    return {
      ruta: grupo.ruta,
      concepto: descripcion || grupo.ruta.split('.').at(-1),
      codigo: valorGrupo(grupo, ['codigo','id','codigoRegimen','codigoImpuesto']),
      baseImponible: parsearNumero(valorGrupo(grupo, ['baseImponible','importeBase','baseCalculo'])),
      alicuota: parsearNumero(valorGrupo(grupo, ['alicuota','porcentaje','tasa'])),
      importe
    };
  }).filter(Boolean);
  const participantes = grupos.map(grupo => {
    const cuit = String(valorGrupo(grupo, ['cuit','cuitPersona','cuitParticipante','cuitLiquidador','cuitVendedor','cuitProductor','cuitComprador','cuitCorredor']) || '').replace(/\D/g, '');
    if (cuit.length !== 11) return null;
    return {
      rol: nombreCampo(grupo.ruta),
      cuit,
      nombre: valorGrupo(grupo, ['razonSocial','denominacion','nombre','apellidoNombre','razonSocialLiquidador','razonSocialVendedor','razonSocialProductor']) || null
    };
  }).filter(Boolean).filter((item, index, todos) => todos.findIndex(otro => otro.rol === item.rol && otro.cuit === item.cuit) === index);
  const items = grupos.map(grupo => {
    const producto = valorGrupo(grupo, ['descripcionGrano','descGrano','producto','especie','grano','descripcionProducto']);
    const kilosItem = parsearNumero(valorGrupo(grupo, ['kilosNetos','kgNetos','pesoNeto','cantidadKilos','kilogramos','kilosLiquidados']));
    const precio = parsearNumero(valorGrupo(grupo, ['precioTonelada','precioPorTonelada','precio','precioOperacion']));
    if (!producto && kilosItem === null && precio === null) return null;
    return {
      ruta: grupo.ruta,
      producto: producto || null,
      codigoProducto: valorGrupo(grupo, ['codigoGrano','codGrano','codigoProducto','codEspecie']),
      campana: valorGrupo(grupo, ['campania','campana','descripcionCampania']),
      kilos: kilosItem,
      toneladas: kilosItem === null ? null : kilosItem / 1000,
      precioTonelada: precio,
      importe: parsearNumero(valorGrupo(grupo, ['importe','importeBruto','subtotal','importeNeto']))
    };
  }).filter(Boolean);
  const kilos = numero(['kilosNetos','kgNetos','pesoNeto','cantidadKilos','kilogramos','kilosLiquidados']);
  const toneladasInformadas = numero(['toneladas','cantidadToneladas','toneladasLiquidadas']);
  const coe = encontrar(['coe','coeLiquidacion','numeroCoe']);
  const tipoDocumento = String(encontrar(['tipoDocumento']) || payload.tipoDocumento || (String(coe || '').startsWith('331') ? 'LSG' : String(coe || '').startsWith('330') ? 'LPG' : '')).toUpperCase();
  const tipoOperacion = encontrar(['tipoOperacion','descripcionOperacion','tipoLiquidacion','descripcionTipoOperacion']);
  const operacionNormalizada = normalizar(tipoOperacion);
  const tipoFormularioHistorico = /consign/.test(operacionNormalizada)
    ? '1116 C / Consignación'
    : /compraventa|comprayventa/.test(operacionNormalizada)
      ? '1116 B / Compraventa'
      : null;
  return {
    coe,
    familiaDocumento: tipoDocumento === 'LSG' ? 'Liquidación secundaria de granos (LSG)' : tipoDocumento === 'LPG' ? 'Liquidación primaria de granos (LPG)' : tipoDocumento || null,
    tipoFormularioHistorico,
    tipoOperacion,
    estado: encontrar(['estado','estadoLiquidacion']),
    liquidadorCuit: encontrar(['cuitLiquidador','cuitEmisor','cuitComprador','cuitCorredor']),
    liquidadorNombre: encontrar(['razonSocialLiquidador','denominacionLiquidador','nombreLiquidador','razonSocialEmisor']),
    receptorCuit: encontrar(['cuitVendedor','cuitProductor','cuitReceptor','cuitRepresentado']),
    receptorNombre: encontrar(['razonSocialVendedor','nombreProductor','razonSocialProductor','denominacionReceptor']),
    producto: encontrar(['descripcionGrano','descGrano','producto','especie','grano']),
    campana: encontrar(['campania','campana','descripcionCampania']),
    kilos,
    toneladas: toneladasInformadas ?? (kilos !== null ? kilos / 1000 : null),
    precioTonelada: numero(['precioTonelada','precioPorTonelada','precio','precioOperacion']),
    importeBruto: numero(['importeBruto','importeTotalBruto','subtotalBruto']),
    importeNeto: numero(['importeNeto','netoGravado','importeNetoGravado','subtotalNeto']),
    iva: numero(['importeIva','iva','montoIva']),
    sellado: numero(['sellado','impuestoSellos','importeSellos','retencionSellos']),
    retencionGanancias: numero(['retencionGanancias','importeRetencionGanancias','ganancias']),
    retencionIva: numero(['retencionIva','importeRetencionIva','ivaRetenido']),
    comisiones: numero(['comision','comisiones','importeComision']),
    otrasRetenciones: numero(['otrasRetenciones','importeOtrasRetenciones']),
    otrosConceptos: numero(['otrosConceptos','otrosTributos','gastos']),
    importeTotal: numero(['importeTotal','total','totalLiquidacion','importeNetoAPagar']),
    moneda: encontrar(['moneda','codigoMoneda','monId']),
    participantes,
    items,
    conceptosImpositivos,
    camposOficiales: campos
  };
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
  const esLiquidacion = fuente === 'WSLPG_LIQUIDACIONES';
  const conditions = [esLiquidacion
    ? `(d.fuente LIKE 'WSLPG_%' AND d.fuente NOT LIKE '%CERTIFICACION%')`
    : 'd.fuente = $1'];
  const params = esLiquidacion ? [] : [fuente];
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
           cp.cuit AS contraparte_cuit,
           EXISTS(
             SELECT 1 FROM arca_official_files f
             WHERE f.document_id=d.id AND f.file_type='PDF'
           ) AS tiene_pdf
    ${baseJoin}
    WHERE ${where}
    ORDER BY d.document_date DESC NULLS LAST, d.id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, queryParams);
  return {
    documentos: rows.map(row => {
      const payload = row.payload || {};
      const detalleLiquidacion = esLiquidacion ? detalleLiquidacionWslpg(payload) : null;
      const { rawXml, ...publicPayload } = payload;
      return {
        ...row,
        payload: { ...publicPayload, ...detalleFiscalWsfe(payload) },
        detalle_liquidacion: detalleLiquidacion,
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



async function importarCertificadoInteractivo({ coe, metadata = {}, pdfBuffer }) {
  await ensureSyncTables();
  const safeCoe = String(coe || '').replace(/\D/g, '');
  if (!/^332\d{9}$/.test(safeCoe)) {
    throw new Error('COE de certificado invalido.');
  }
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length < 5 ||
      pdfBuffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('El archivo no es un PDF valido.');
  }
  const fechaTexto = String(metadata.fecha_emision || '');
  const fechaMatch = fechaTexto.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const fecha = fechaMatch
    ? `${fechaMatch[3]}-${fechaMatch[2]}-${fechaMatch[1]}`
    : null;
  const payload = {
    ...metadata,
    coe: safeCoe,
    origen: 'SERVICIO_INTERACTIVO_ARCA',
    soloConsulta: true
  };
  const resultado = await guardarDocumentoOficial(
    'ARCA_CEG_INTERACTIVO',
    safeCoe,
    fecha,
    payload,
    pdfBuffer
  );
  return {
    coe: safeCoe,
    documentId: resultado.documentId,
    pdfGuardado: resultado.pdfGuardado,
    ctgs: Array.isArray(metadata.ctgs) ? metadata.ctgs.length : 0
  };
}

async function materializarCertificadosCtg() {
  await ensureSyncTables();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS arca_certificado_ctg_links (
      id BIGSERIAL PRIMARY KEY,
      certificado_document_id BIGINT NOT NULL
        REFERENCES arca_official_documents(id) ON DELETE CASCADE,
      certificado_coe VARCHAR(20) NOT NULL,
      ctg VARCHAR(20) NOT NULL,
      cpe_document_id BIGINT
        REFERENCES arca_official_documents(id) ON DELETE SET NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(certificado_document_id, ctg)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_arca_certificado_ctg_links_ctg
    ON arca_certificado_ctg_links(ctg)
  `);

  const { rows: certificados } = await pool.query(`
    SELECT id, external_key AS coe, payload
    FROM arca_official_documents
    WHERE fuente IN ('WSLPG_CERTIFICACION', 'WSLPG_CERTIFICACION_COE', 'ARCA_CEG_INTERACTIVO')
    ORDER BY id
  `);
  let certificadosConCtg = 0;
  let relaciones = 0;
  let vinculadas = 0;
  let pendientes = 0;

  for (const certificado of certificados) {
    const rawXml = String(certificado.payload?.rawXml || '');
    const ctgsPayload = Array.isArray(certificado.payload?.ctgs)
      ? certificado.payload.ctgs
      : [];
    const ctgs = [...new Set([...ctgsPayload, ...tags(rawXml, 'ctg')]
      .map(value => String(value || '').replace(/\D/g, ''))
      .filter(value => /^\d{8,20}$/.test(value)))];
    if (ctgs.length) certificadosConCtg += 1;

    for (const ctg of ctgs) {
      const { rows: cpes } = await pool.query(`
        SELECT id
        FROM arca_official_documents
        WHERE external_key=$1
          AND fuente IN ('WSCPE_CPE', 'WSCPE_CTG', 'WSCPE_DESTINO')
        ORDER BY CASE
          WHEN fuente='WSCPE_CPE' THEN 0
          WHEN fuente='WSCPE_CTG' THEN 1
          ELSE 2
        END, id
        LIMIT 1
      `, [ctg]);
      const cpeDocumentId = cpes[0]?.id || null;
      const estado = cpeDocumentId ? 'VINCULADO' : 'PENDIENTE';
      await pool.query(`
        INSERT INTO arca_certificado_ctg_links
          (certificado_document_id, certificado_coe, ctg, cpe_document_id, estado)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (certificado_document_id, ctg) DO UPDATE
        SET cpe_document_id=EXCLUDED.cpe_document_id,
            estado=EXCLUDED.estado,
            updated_at=NOW()
      `, [certificado.id, certificado.coe, ctg, cpeDocumentId, estado]);
      relaciones += 1;
      if (cpeDocumentId) vinculadas += 1;
      else pendientes += 1;
    }
  }

  return {
    certificadosRevisados: certificados.length,
    certificadosConCtg,
    relaciones,
    vinculadas,
    pendientes
  };
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
  consultarPadronA13,
  iniciarSyncFacturasEmitidas,
  iniciarSyncWslpg,
  iniciarSyncWslpgPdfPorCoe,
  importarWslpgPorCoe,
  iniciarSyncWslpgAjustesPorCoe,
  importarWslpgAjustesPorCoe,
  iniciarSyncCpePorCtg,
  iniciarSyncCpeDestino,
  consultarPlantasWscpe,
  consultarCpesDestinoWscpe,
  consultarCpePorCtg,
  consultarTiposGranoWscpe,
  consultarDerivadosGranariosWscpe,
  importarCpePorCtg,
  obtenerPdfDocumento,
  obtenerSyncJob,
  obtenerResumenDocumentos,
  listarDocumentosOficiales,
  resumirConciliacionContrapartes,
  resumirIvaVentas,
  listarConciliacionesCuentaCorriente,
  decidirConciliacionCuentaCorriente,
  importarCpeNormalizada,
  materializarMovimientosCpe,
  diagnosticarDerivadosPendientes,
  listarReporteCpeCertificados,
  listarReporteCpeIntervinientes,
  iniciarRefreshDerivadosPendientes,
  materializarCertificadosCtg,
  importarCertificadoInteractivo,
  productoCpeOficial,
  diagnosticarCredenciales,
  _internal: {
    productoCpeOficial,
    seleccionarPersonaReporte,
    catalogoCodigoDescripcion,
    descripcionEspecificaDerivado,
    xmlEscape,
    decodeXml,
    tag,
    tags,
    tipoWslpgPorCoe,
    solicitudWslpgPorCoe,
    solicitudAjusteWslpgPorCoe,
    parsearAjusteWslpg,
    decodificarPdfWslpg,
    payloadOficialSinPdf,
    fechaWslpg,
    wslpgBusinessError,
    detalleFiscalWsfe,
    detalleLiquidacionWslpg,
    signoComprobanteWsfe,
    xmlToObject,
    extraerIntervinientesCpe,
    extraerPlantasCpe,
    erroresWscpe,
    fechaCpe,
    normalizarCuit,
    normalizarNumeroPlanta,
    tipoContrapartePorRol,
    parsearPersonaPadronA13,
    validarFechaIso,
    rangosWscpe,
    normalizarEstadoCpe,
    esEstadoConfirmadoCpe,
    estadoCpeDesdePayload,
    clasificarOrigenCtg,
    wscpeTargets,
    getConfig,
    validateCredentials
  }
};

        AND (d.document_date >= $1::date OR ($2::text[] IS NOT NULL AND r.ctg=ANY($2::text[])))
        AND ($2::text[] IS NULL OR r.ctg=ANY($2::text[]))
      ORDER BY document_date, r.ctg
    `, [fechaDesde, ctgsFiltrados?.length ? ctgsFiltrados : null]);

    const { rows: secuencia } = await client.query(`
      SELECT COALESCE(MAX((regexp_match(numero_movimiento, '^MOV-([0-9]+)$'))[1]::bigint),0) AS ultimo
      FROM movimientos WHERE numero_movimiento ~ '^MOV-[0-9]+$'
    `);
    let siguiente = Number(secuencia[0]?.ultimo || 0) + 1;

    const pickRol = (items, patrones) => items.find(item => patrones.some(pattern => pattern.test(String(item.rol || '')))) || null;
    resultado.actualizadas = 0;
    for (const doc of documentos) {
      resultado.revisadas += 1;
      const payload = doc.payload || {};
      const rawXml = String(payload.rawXml || payload.raw_xml || '');
      const estadoOficial = estadoCpeDesdePayload(payload);
      if (soloConfirmadas && !esEstadoConfirmadoCpe(estadoOficial)) {
        resultado.omitidasNoConfirmadas += 1;
        continue;
      }
      resultado.confirmadas += 1;
      const datosCarga = payload.datosCarga || payload.datos_carga || {};
      const cabecera = payload.cabecera || {};
      const transporte = payload.transporte || {};
      if (!datosCarga.codGrano) {
        datosCarga.codGrano = primerTag(rawXml, ['codGrano', 'codigoGrano', 'codEspecie', 'codigoEspecie']);
      }
      if (!datosCarga.codDerivadoGranario) {
        datosCarga.codDerivadoGranario = primerTag(rawXml, ['codDerivadoGranario', 'codigoDerivadoGranario']);
      }
      const producto = productoCpeOficial(doc.tipo_cpe, datosCarga, payload, catalogos);
      const especie = await asegurarEspecieProductoCpe(client, producto);
      const participantes = Array.isArray(doc.participantes) ? doc.participantes : [];
      const plantas = Array.isArray(doc.plantas) ? doc.plantas : [];
      const plantaOrigen = plantas.find(item => /ORIGEN/i.test(String(item.rol || ''))) || null;
      const clasificacionOrigen = clasificarOrigenCtg(doc.ctg);

      const { rows: ya } = await client.query('SELECT id,id_especie,observaciones FROM movimientos WHERE nro_ctg=$1 LIMIT 1', [doc.ctg]);
      if (ya[0]) {
        await client.query(`
          UPDATE movimientos SET
            tipo_origen_cpe=COALESCE($1,tipo_origen_cpe),
            origen_produccion=COALESCE($2,origen_produccion),
            nro_planta_origen=COALESCE($3,nro_planta_origen),
            id_ubicacion_origen=COALESCE($4,id_ubicacion_origen)
          WHERE id=$5
        `, [clasificacionOrigen.tipoOrigenCpe, clasificacionOrigen.origenProduccion,
          plantaOrigen?.nro_planta || null, plantaOrigen?.ubicacion_id || null, ya[0].id]);
        if (especie && Number(ya[0].id_especie) !== Number(especie.id)) {
          const notaProducto = `Producto ARCA: ${producto.nombre} (código ${producto.codigoArca}).`;
          const observacionActual = String(ya[0].observaciones || '')
            .replace(/\s*Producto ARCA:[^.]*\./gi, '')
            .trim();
          await client.query(
            'UPDATE movimientos SET id_especie=$1,observaciones=$2 WHERE id=$3',
            [especie.id, `${observacionActual} ${notaProducto}`.trim(), ya[0].id]
          );
          resultado.actualizadas += 1;
        }
        await client.query(`INSERT INTO arca_cpe_movement_links(ctg,document_id,movimiento_id,created_by)
          VALUES($1,$2,$3,$4) ON CONFLICT(ctg) DO NOTHING`, [doc.ctg, doc.document_id, ya[0].id, userId]);
        await client.query('DELETE FROM arca_cpe_movement_pending WHERE ctg=$1', [doc.ctg]);
        resultado.existentes += 1;
        continue;
      }
      const motivos = [];
      if (!doc.document_date) motivos.push('FECHA_CPE_FALTANTE');
      if (!especie) motivos.push(producto.esDerivado ? 'DERIVADO_SIN_MAPEO' : 'ESPECIE_SIN_MAPEO');
      if (motivos.length) {
        await client.query(`INSERT INTO arca_cpe_movement_pending(ctg,document_id,motivos,payload_hash)
          VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(ctg) DO UPDATE SET document_id=EXCLUDED.document_id,motivos=EXCLUDED.motivos,payload_hash=EXCLUDED.payload_hash,updated_at=NOW()`,
          [doc.ctg, doc.document_id, JSON.stringify(motivos), doc.payload_hash]);
        resultado.pendientes += 1;
        if (resultado.detallePendientes.length < 50) resultado.detallePendientes.push({ ctg: doc.ctg, motivos });
        continue;
      }

      const persona = item => ({ cuit: item?.cuit || null, nombre: item?.razon_social_oficial || null });
      const titular = persona(pickRol(participantes, [/SOLICITANTE/i, /TITULAR/i, /^ORIGEN$/i]));
      const remitente = persona(pickRol(participantes, [/REMITENTE_COMERCIAL_VENTA_PRIMARIA/i, /^REMITENTE_COMERCIAL$/i, /^ORIGEN$/i]));
      const remitenteVenta = persona(pickRol(participantes, [/REMITENTE_COMERCIAL_VENTA_PRIMARIA/i]));
      const destinatario = persona(pickRol(participantes, [/^DESTINATARIO$/i]));
      const destino = persona(pickRol(participantes, [/^DESTINO$/i, /TITULAR_PLANTA/i]));
      const pagador = persona(pickRol(participantes, [/PAGADOR_FLETE/i]));
      const plantaDestino = plantas.find(item => /DESTINO/i.test(String(item.rol || ''))) || null;
      const bruto = Number(datosCarga.pesoBruto || datosCarga.pesoBrutoOrigen || primerTag(rawXml, ['pesoBruto', 'pesoBrutoOrigen', 'pesoBrutoSalida']) || 0) || null;
      const tara = Number(datosCarga.pesoTara || datosCarga.tara || primerTag(rawXml, ['pesoTara', 'tara', 'pesoTaraOrigen']) || 0) || null;
      const neto = Number(datosCarga.pesoNeto || datosCarga.pesoNetoCarga || primerTag(rawXml, ['pesoNeto', 'pesoNetoCarga', 'pesoNetoOrigen', 'kilosNetos']) || 0) || (bruto && tara ? bruto - tara : null);
      const estadoArca = String(cabecera.estado || primerTag(rawXml, ['estado', 'estadoCartaPorte']) || '');
      const estado = /ANUL/i.test(estadoArca) ? 'ANULADO' : /RECHAZ/i.test(estadoArca) ? 'RECHAZADO' : 'EN_TRANSITO';
      const numeroMovimiento = `MOV-${String(siguiente++).padStart(4, '0')}`;
      const { rows: creadas } = await client.query(`
        INSERT INTO movimientos(
          numero_movimiento,modalidad,estado,estado_liquidacion,nro_cpe,nro_ctg,fecha_cpe,
          titular_cpe_cuit,titular_cpe_nombre,remitente_comercial_productor_cuit,remitente_comercial_productor_nombre,
          rte_comercial_venta_primaria_cuit,rte_comercial_venta_primaria_nombre,destinatario_cuit,destinatario_nombre,
          destino_cuit,destino_nombre,flete_pagador_cuit,flete_pagador_nombre,id_especie,
          localidad_origen,provincia_origen,nro_planta_origen,nro_planta_destino,localidad_destino,provincia_destino,
          id_ubicacion_origen,id_ubicacion_destino,tipo_origen_cpe,origen_produccion,
          patente_chasis,patente_acoplado,fecha_partida,km_a_recorrer,
          peso_bruto_salida_kg,peso_tara_salida_kg,peso_neto_salida_kg,observaciones,usuario_carga
        ) VALUES($1,'FORMAL',$2,'SIN_ASIGNAR',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
          $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37) RETURNING id
      `, [numeroMovimiento,estado,numeroCpe(primerTag(rawXml,['nroCartaPorte','nroCPE','numeroCartaPorte'])),doc.ctg,doc.document_date,
        titular.cuit,titular.nombre,remitente.cuit,remitente.nombre,remitenteVenta.cuit,remitenteVenta.nombre,
        destinatario.cuit,destinatario.nombre,destino.cuit,destino.nombre,pagador.cuit,pagador.nombre,especie.id,
        plantaOrigen?.localidad||null,plantaOrigen?.provincia||null,plantaOrigen?.nro_planta||null,
        plantaDestino?.nro_planta||null,plantaDestino?.localidad||null,plantaDestino?.provincia||null,
        plantaOrigen?.ubicacion_id||null,plantaDestino?.ubicacion_id||null,
        clasificacionOrigen.tipoOrigenCpe,clasificacionOrigen.origenProduccion,
        transporte.dominio||transporte.patenteChasis||primerTag(rawXml,['patenteChasis','dominioAutomotor','patenteCamion']),
        transporte.dominioAcoplado||transporte.patenteAcoplado||primerTag(rawXml,['patenteAcoplado','dominioAcoplado']),
        transporte.fechaHoraPartida||transporte.fechaPartida||primerTag(rawXml,['fechaPartida','fechaInicioViaje']),
        Number(transporte.kmRecorrer||transporte.kilometros||primerTag(rawXml,['kmRecorrer','kilometros','distanciaKm'])||0)||null,bruto,tara,neto,
        `Importado de ARCA ${doc.tipo_cpe}; CTG ${doc.ctg}. Documento oficial ${doc.document_id}.`,userId]);
      await client.query(`INSERT INTO arca_cpe_movement_links(ctg,document_id,movimiento_id,created_by) VALUES($1,$2,$3,$4)`, [doc.ctg,doc.document_id,creadas[0].id,userId]);
      await client.query('DELETE FROM arca_cpe_movement_pending WHERE ctg=$1', [doc.ctg]);
      resultado.creadas += 1;
    }
    await client.query('COMMIT');
    return resultado;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function camposEscalaresDiagnostico(value, path = '', salida = [], visitados = new Set()) {
  if (value === null || value === undefined || salida.length >= 300 || visitados.has(value)) return salida;
  if (typeof value === 'object') {
    visitados.add(value);
    for (const [clave, contenido] of Object.entries(value)) {
      if (/rawxml|raw_xml|pdf|token|sign|cert|key/i.test(clave)) continue;
      camposEscalaresDiagnostico(contenido, path ? `${path}.${clave}` : clave, salida, visitados);
    }
    return salida;
  }
  const texto = String(value).trim();
  if (!texto || texto.length > 120 || /^\d{11,20}$/.test(texto)) return salida;
  salida.push({ path, value: texto });
  return salida;
}

async function diagnosticarDerivadosPendientes() {
  const { rows } = await pool.query(`
    SELECT p.ctg,d.payload
    FROM arca_cpe_movement_pending p
    JOIN arca_official_documents d ON d.id=p.document_id
    WHERE p.motivos @> '["DERIVADO_SIN_MAPEO"]'::jsonb
    ORDER BY p.ctg LIMIT 5
  `);
  return rows.map(row => ({
    ctg: row.ctg,
    campos: camposEscalaresDiagnostico(row.payload).filter(item =>
      /producto|grano|deriv|mercader|especie|carga|cod|desc/i.test(item.path)
    )
  }));
}

async function listarReporteCpeCertificados() {
  const cuitInversiones = '30710183992';
  const { rows: certificadosRows } = await pool.query(`
    SELECT c.id,c.coe,c.numero_certificado,c.fecha_emision,
      c.kilos_netos_acondicionados,
      COUNT(cc.id)::int AS total_ctgs,
      COUNT(cc.id) FILTER (WHERE cc.cpe_document_id IS NOT NULL)::int AS ctgs_vinculados,
      COALESCE(SUM(cc.kg_netos_acondicionados)
        FILTER (WHERE cc.cpe_document_id IS NOT NULL),0) AS kilos_asignados
    FROM certificados_1116 c
    LEFT JOIN certificado_1116_ctgs cc ON cc.id_certificado_1116=c.id
    GROUP BY c.id,c.coe,c.numero_certificado,c.fecha_emision,c.kilos_netos_acondicionados
    ORDER BY c.fecha_emision,c.coe,c.id
  `);
  const certificados = certificadosRows.map(row => {
    const totalCtgs=Number(row.total_ctgs||0);
    const ctgsVinculados=Number(row.ctgs_vinculados||0);
    const kilosCertificados=row.kilos_netos_acondicionados==null?null:Number(row.kilos_netos_acondicionados);
    const kilosAsignados=Number(row.kilos_asignados||0);
    return {
      id:row.id,
      coe:row.coe,
      numeroCertificado:row.numero_certificado,
      fecha:row.fecha_emision,
      totalCtgs,
      ctgsVinculados,
      estado:totalCtgs===0?'SIN_CTG':ctgsVinculados===totalCtgs?'COMPLETO':ctgsVinculados>0?'PARCIAL':'PENDIENTE',
      kilosCertificados,
      kilosAsignados,
      saldoKilos:kilosCertificados==null?null:kilosCertificados-kilosAsignados
    };
  });
  const certificadosConKilos=certificados.filter(item=>item.kilosCertificados!=null);
  const resumenCertificados = {
    total:certificados.length,
    completos:certificados.filter(item=>item.estado==='COMPLETO').length,
    parciales:certificados.filter(item=>item.estado==='PARCIAL').length,
    pendientes:certificados.filter(item=>item.estado==='PENDIENTE').length,
    sinCtg:certificados.filter(item=>item.estado==='SIN_CTG').length,
    kilosCertificados:certificadosConKilos.reduce((s,item)=>s+item.kilosCertificados,0),
    kilosAsignados:certificados.reduce((s,item)=>s+item.kilosAsignados,0),
    saldoKilos:certificadosConKilos.reduce((s,item)=>s+item.saldoKilos,0),
    sinKilos:certificados.length-certificadosConKilos.length
  };
  const { rows } = await pool.query(`
    SELECT r.ctg,d.document_date,
      COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
        'rol',p.rol,'cuit',p.cuit,'nombre',p.razon_social_oficial
      )) FILTER (WHERE p.id IS NOT NULL),'[]'::jsonb) AS participantes,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'rol',pl.rol,'planta',pl.nro_planta,'cuit',pl.cuit_titular,
        'nombre',pl.nombre_oficial,'localidad',pl.localidad,'provincia',pl.provincia
      ) ORDER BY pl.rol,pl.nro_planta) FROM arca_cpe_plants pl
        WHERE pl.document_id=r.document_id),'[]'::jsonb) AS plantas,
      COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object(
        'coe',l.certificado_coe,'estado',l.estado
      )) FROM arca_certificado_ctg_links l WHERE l.ctg=r.ctg AND l.cpe_document_id=r.document_id),'[]'::jsonb) AS certificados
    FROM arca_cpe_registry r
    JOIN arca_official_documents d ON d.id=r.document_id
    JOIN arca_cpe_participants objetivo
      ON objetivo.document_id=r.document_id AND objetivo.cuit=$1
    LEFT JOIN arca_cpe_participants p ON p.document_id=r.document_id
    WHERE r.ctg LIKE '101%'
    GROUP BY r.ctg,r.document_id,d.document_date
    ORDER BY r.ctg
  `, [cuitInversiones]);

  const rolesInteres = /^(ORIGEN|SOLICITANTE|TITULAR_PLANTA|DESTINO|DESTINATARIO|REMITENTE_COMERCIAL(?:_VENTA_(?:PRIMARIA|SECUNDARIA)(?:_2)?)?)$/;
  const detalle = rows.map(row => {
    const intervinientes=(row.participantes || []).filter(item => rolesInteres.test(String(item.rol || '')));
    const origenPropio=intervinientes.some(p=>p.rol==='ORIGEN'&&p.cuit===cuitInversiones);
    const destinoPropio=intervinientes.some(p=>/^(DESTINO|DESTINATARIO)$/.test(p.rol)&&p.cuit===cuitInversiones);
    const certificados=row.certificados||[];
    return {
      ctg:row.ctg,
      fecha:row.document_date,
      estadoCertificado:certificados.length?'VINCULADO':'SIN_CERTIFICADO',
      clasificacion:origenPropio&&destinoPropio?'TRASLADO_PROPIO':destinoPropio?'TERCERO_A_PLANTA_PROPIA':'REVISAR',
      intervinientes,
      plantas:row.plantas||[],
      certificados
    };
  });
  return {
    resumen:{
      total:detalle.length,
      vinculadas:detalle.filter(item=>item.estadoCertificado==='VINCULADO').length,
      sinCertificado:detalle.filter(item=>item.estadoCertificado==='SIN_CERTIFICADO').length,
      trasladosPropiosSinCertificado:detalle.filter(item=>item.estadoCertificado==='SIN_CERTIFICADO'&&item.clasificacion==='TRASLADO_PROPIO').length,
      tercerosSinCertificado:detalle.filter(item=>item.estadoCertificado==='SIN_CERTIFICADO'&&item.clasificacion==='TERCERO_A_PLANTA_PROPIA').length
    },
    detalle,
    resumenCertificados,
    certificados
  };
}

function seleccionarPersonaReporte(intervinientes = [], roles = []) {
  for (const rol of roles) {
    const persona = intervinientes.find(item => String(item.rol || '').toUpperCase() === rol);
    if (persona) return persona;
  }
  return null;
}

// Reporte operativo completo para exportar CPE/CPEDG. Es solo lectura y usa
// las tablas normalizadas para no depender de la forma interna del XML de ARCA.
async function listarReporteCpeIntervinientes() {
  await ensureCpeMasterTables();
  const { rows } = await pool.query(`
    SELECT r.ctg,r.tipo_cpe,d.document_date,d.payload,d.payload_hash,
      m.numero_movimiento,m.estado AS estado_movimiento,
      m.peso_bruto_salida_kg,m.peso_tara_salida_kg,m.peso_neto_salida_kg,
      m.patente_chasis,m.patente_acoplado,m.fecha_partida,m.km_a_recorrer,
      e.nombre AS producto_nombre,e.codigo AS producto_codigo,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'rol',p.rol,'cuit',p.cuit,
        'nombre',COALESCE(p.razon_social_oficial,c.razon_social),
        'contraparteId',p.contraparte_id
      ) ORDER BY p.rol,p.cuit)
        FROM arca_cpe_participants p
        LEFT JOIN contrapartes c ON c.id=p.contraparte_id
        WHERE p.document_id=r.document_id),'[]'::jsonb) AS intervinientes,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'rol',pl.rol,'planta',pl.nro_planta,'cuitTitular',pl.cuit_titular,
        'nombre',pl.nombre_oficial,'localidad',pl.localidad,
        'provincia',pl.provincia,'direccion',pl.direccion
      ) ORDER BY pl.rol,pl.nro_planta)
        FROM arca_cpe_plants pl WHERE pl.document_id=r.document_id),'[]'::jsonb) AS plantas,
      COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object(
        'coe',l.certificado_coe,'estado',l.estado
      )) FROM arca_certificado_ctg_links l
        WHERE l.ctg=r.ctg AND l.cpe_document_id=r.document_id),'[]'::jsonb) AS certificados
    FROM arca_cpe_registry r
    JOIN arca_official_documents d ON d.id=r.document_id
    LEFT JOIN arca_cpe_movement_links ml ON ml.ctg=r.ctg
    LEFT JOIN movimientos m ON m.id=ml.movimiento_id
    LEFT JOIN especies e ON e.id=m.id_especie
    ORDER BY d.document_date,r.ctg
  `);

  const detalle = rows.map(row => {
    const payload = row.payload || {};
    const intervinientes = Array.isArray(row.intervinientes) ? row.intervinientes : [];
    const datosCarga = payload.datosCarga || payload.datos_carga || {};
    const producto = productoCpeOficial(row.tipo_cpe, datosCarga, payload);
    const comprador = seleccionarPersonaReporte(intervinientes, [
      'COMPRADOR','DESTINATARIO','DESTINO','REMITENTE_COMERCIAL_VENTA_PRIMARIA'
    ]);
    const vendedor = seleccionarPersonaReporte(intervinientes, [
      'VENDEDOR','REMITENTE_COMERCIAL','ORIGEN','SOLICITANTE'
    ]);
    const transporte = payload.transporte || {};
    const rawXml = String(payload.rawXml || payload.raw_xml || '');
    const numero = value => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
    };
    const bruto = numero(row.peso_bruto_salida_kg)
      || numero(valorAnidadoPorClaves(payload, ['pesoBruto','pesoBrutoOrigen','pesoBrutoSalida']))
      || numero(primerTag(rawXml, ['pesoBruto','pesoBrutoOrigen','pesoBrutoSalida']));
    const tara = numero(row.peso_tara_salida_kg)
      || numero(valorAnidadoPorClaves(payload, ['pesoTara','tara','pesoTaraOrigen']))
      || numero(primerTag(rawXml, ['pesoTara','tara','pesoTaraOrigen']));
    const neto = numero(row.peso_neto_salida_kg)
      || numero(valorAnidadoPorClaves(payload, ['pesoNeto','pesoNetoCarga','pesoNetoOrigen','kilosNetos']))
      || numero(primerTag(rawXml, ['pesoNeto','pesoNetoCarga','pesoNetoOrigen','kilosNetos']))
      || (bruto && tara ? bruto - tara : null);
    return {
      ctg: row.ctg,
      fecha: row.document_date,
      tipoCpe: row.tipo_cpe,
      estadoArca: estadoCpeDesdePayload(payload) || null,
      producto: row.producto_nombre || producto.nombre || null,
      codigoProducto: producto.codigoArca || row.producto_codigo || null,
      pesoBrutoKg: bruto,
      taraKg: tara,
      pesoNetoKg: neto,
      patenteChasis: row.patente_chasis || transporte.dominio || transporte.patenteChasis
        || primerTag(rawXml, ['patenteChasis','dominioAutomotor','patenteCamion']) || null,
      patenteAcoplado: row.patente_acoplado || transporte.dominioAcoplado || transporte.patenteAcoplado
        || primerTag(rawXml, ['patenteAcoplado','dominioAcoplado']) || null,
      fechaPartida: row.fecha_partida || transporte.fechaHoraPartida || transporte.fechaPartida || null,
      kilometros: numero(row.km_a_recorrer) || numero(transporte.kmRecorrer || transporte.kilometros),
      numeroMovimiento: row.numero_movimiento || null,
      estadoMovimiento: row.estado_movimiento || null,
      comprador,
      vendedor,
      intervinientes,
      plantas: Array.isArray(row.plantas) ? row.plantas : [],
      certificados: Array.isArray(row.certificados) ? row.certificados : [],
      payloadHash: row.payload_hash
    };
  });
  return {
    total: detalle.length,
    conCompradorIdentificado: detalle.filter(item => item.comprador).length,
    conCertificado: detalle.filter(item => item.certificados.length > 0).length,
    detalle
  };
}

async function iniciarRefreshDerivadosPendientes() {
  const { rows } = await pool.query(`
    SELECT ctg FROM arca_cpe_movement_pending
    WHERE motivos @> '["DERIVADO_SIN_MAPEO"]'::jsonb ORDER BY ctg
  `);
  const ctgs = rows.map(row => row.ctg);
  if (!ctgs.length) return null;
  return iniciarSyncCpePorCtg({ ctgs, desde: '2026-02-01' });
}

async function ejecutarSyncCpeDestino(jobId, { desde, hasta, userId = null, soloConfirmadas = true }) {
  await pool.query("UPDATE arca_sync_jobs SET estado='EJECUTANDO', started_at=NOW() WHERE id=$1", [jobId]);
  const errores = [];
  let importados = 0;
  let revisados = 0;
  let listados = 0;
  let omitidosNoConfirmados = 0;
  try {
    const config = getConfig();
    const plantas = await consultarPlantasWscpe(config.cuit);
    if (!plantas.length) {
      throw new Error(`ARCA no informo plantas activas para el CUIT ${config.cuit}.`);
    }

    const ctgs = new Set();
    for (const planta of plantas) {
      for (const rango of rangosWscpe(desde, hasta)) {
        try {
          const cartas = await consultarCpesDestinoWscpe({
            planta: planta.nroPlanta,
            desde: rango.desde,
            hasta: rango.hasta
          });
          listados += cartas.length;
          cartas.forEach(item => {
            if (soloConfirmadas && !esEstadoConfirmadoCpe(item.estado)) {
              omitidosNoConfirmados += 1;
              return;
            }
            ctgs.add(item.ctg);
          });
        } catch (error) {
          errores.push({
            fase: 'LISTADO',
            planta: planta.nroPlanta,
            desde: rango.desde,
            hasta: rango.hasta,
            error: error.message
          });
        }
      }
    }

    for (const ctg of ctgs) {
      revisados += 1;
      try {
        await importarCpePorCtg(ctg, { jobId, userId });
        importados += 1;
      } catch (error) {
        errores.push({ fase: 'DETALLE', ctg, error: error.message });
      }
      await pool.query(`
        UPDATE arca_sync_jobs SET total_importados=$1,total_revisados=$2 WHERE id=$3
      `, [importados, revisados, jobId]);
    }

    const estado = errores.length ? (importados ? 'PARCIAL' : 'ERROR') : 'COMPLETADO';
    const resumen = {
      listados,
      ctgConfirmadosUnicos: ctgs.size,
      omitidosNoConfirmados,
      errores
    };
    await pool.query(`
      UPDATE arca_sync_jobs
      SET estado=$1,total_importados=$2,total_revisados=$3,error=$4,finished_at=NOW()
      WHERE id=$5
    `, [estado, importados, revisados, JSON.stringify(resumen).slice(0, 20000), jobId]);
  } catch (error) {
    await pool.query(`
      UPDATE arca_sync_jobs
      SET estado='ERROR',total_importados=$1,total_revisados=$2,error=$3,finished_at=NOW()
      WHERE id=$4
    `, [importados, revisados, error.message, jobId]);
  }
}

async function iniciarSyncCpeDestino({
  desde = '2026-02-01',
  hasta = new Date().toISOString().slice(0, 10),
  userId = null,
  soloConfirmadas = true
} = {}) {
  const fechaDesde = validarFechaIso(desde, 'La fecha desde');
  const fechaHasta = validarFechaIso(hasta, 'La fecha hasta');
  if (fechaDesde > fechaHasta) throw new Error('La fecha desde no puede ser posterior a la fecha hasta.');
  await ensureSyncTables();
  const id = crypto.randomUUID();
  await pool.query(`
    INSERT INTO arca_sync_jobs(id,fuente,desde,estado,solicitado_por)
    VALUES($1,'WSCPE_DESTINO',$2,'PENDIENTE',$3)
  `, [id, fechaDesde, userId]);
  setImmediate(() => void ejecutarSyncCpeDestino(id, {
    desde: fechaDesde,
    hasta: fechaHasta,
    userId,
    soloConfirmadas
  }));
  return {
    id,
    fuente: 'WSCPE_DESTINO',
    desde: fechaDesde,
    hasta: fechaHasta,
    estado: 'PENDIENTE',
    soloConfirmadas
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

function camposOficialesVisibles(value, path = '', salida = [], visitados = new Set()) {
  if (value === null || value === undefined || salida.length >= 500) return salida;
  if (typeof value === 'object') {
    if (visitados.has(value)) return salida;
    visitados.add(value);
    for (const [clave, contenido] of Object.entries(value)) {
      if (/rawxml|raw_xml|pdf|token|sign|firma|certificado_pem|private.?key/i.test(clave)) continue;
      camposOficialesVisibles(contenido, path ? `${path}.${clave}` : clave, salida, visitados);
    }
    return salida;
  }
  const texto = String(value).trim();
  if (texto && texto.length <= 500) salida.push({ campo: path, valor: value });
  return salida;
}

function camposXmlOficiales(xml) {
  const salida = [];
  const pila = [];
  const ocurrencias = new Map();
  const sensible = /^(?:pdf|token|sign|firma|certificado(?:_?pem)?|private.?key)$/i;
  const tokens = String(xml || '').match(/<[^>]+>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!')) continue;
    const cierre = token.match(/^<\/(?:[\w.-]+:)?([\w.-]+)\s*>$/);
    if (cierre) {
      const indice = pila.map(item => item.nombre.toLowerCase()).lastIndexOf(cierre[1].toLowerCase());
      if (indice >= 0) pila.splice(indice);
      continue;
    }
    const apertura = token.match(/^<(?:[\w.-]+:)?([\w.-]+)(?:\s[^>]*)?>$/);
    if (apertura && !/\/\s*>$/.test(token)) {
      const padre = pila.map(item => `${item.nombre}[${item.indice}]`).join('.');
      const clave = `${padre}/${apertura[1].toLowerCase()}`;
      const indice = (ocurrencias.get(clave) || 0) + 1;
      ocurrencias.set(clave, indice);
      pila.push({ nombre: apertura[1], indice });
      continue;
    }
    if (token.startsWith('<') || !pila.length || pila.some(item => sensible.test(item.nombre))) continue;
    const valor = decodeXml(token).replace(/\s+/g, ' ').trim();
    if (valor && valor.length <= 500) salida.push({ campo: pila.map(item => `${item.nombre}[${item.indice}]`).join('.'), valor });
  }
  return salida;
}

function detalleLiquidacionWslpg(payload = {}) {
  const rawXml = String(payload.rawXml || payload.raw_xml || '');
  const { rawXml: omitidoRawXml, raw_xml: omitidoRawXmlAlternativo, ...payloadPublico } = payload;
  void omitidoRawXml;
  void omitidoRawXmlAlternativo;
  const camposPayload = camposOficialesVisibles(payloadPublico);
  const camposXml = camposXmlOficiales(rawXml);
  const campos = [...camposXml, ...camposPayload];
  const normalizar = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const nombreCampo = campo => String(campo || '').split('.').pop().replace(/\[\d+\]$/,'');
  const encontrarEn = (coleccion, aliases) => {
    const buscados = aliases.map(normalizar);
    const exacto = coleccion.find(item => buscados.includes(normalizar(nombreCampo(item.campo))));
    return exacto ? exacto.valor : null;
  };
  const encontrar = aliases => encontrarEn(camposXml, aliases) ?? encontrarEn(camposPayload, aliases);
  const parsearNumero = value => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    let texto = String(value).trim().replace(/[^0-9,.-]/g, '');
    if (!texto || !/[0-9]/.test(texto)) return null;
    const ultimaComa = texto.lastIndexOf(',');
    const ultimoPunto = texto.lastIndexOf('.');
    if (ultimaComa >= 0 && ultimoPunto >= 0) {
      const decimal = ultimaComa > ultimoPunto ? ',' : '.';
      texto = texto.replace(decimal === ',' ? /\./g : /,/g, '').replace(decimal, '.');
    } else if (ultimaComa >= 0) {
      texto = texto.replace(/\./g, '').replace(',', '.');
    } else if ((texto.match(/\./g) || []).length > 1) {
      const partes = texto.split('.');
      texto = `${partes.slice(0, -1).join('')}.${partes.at(-1)}`;
    }
    const parsed = Number(texto);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const numero = aliases => {
    return parsearNumero(encontrar(aliases));
  };
  const agruparPorPadre = coleccion => {
    const grupos = new Map();
    for (const item of coleccion) {
      const partes = item.campo.split('.');
      const clave = partes.slice(0, -1).join('.') || 'raiz';
      if (!grupos.has(clave)) grupos.set(clave, []);
      grupos.get(clave).push({ ...item, nombre: nombreCampo(partes.at(-1)) });
    }
    return [...grupos.entries()].map(([ruta, valores]) => ({ ruta, valores }));
  };
  const valorGrupo = (grupo, aliases) => encontrarEn(grupo.valores.map(item => ({ campo: item.nombre, valor: item.valor })), aliases);
  const grupos = agruparPorPadre(camposXml);
  const conceptosImpositivos = grupos.map(grupo => {
    const ruta = normalizar(grupo.ruta);
    const descripcion = valorGrupo(grupo, ['descripcion','detalle','concepto','tipoRetencion','tipoImpuesto']);
    const importe = parsearNumero(valorGrupo(grupo, ['importe','monto','importeRetencion','importeImpuesto','importeTributo','importeIva']));
    const esImpositivo = /iva|retenc|percepc|ganancia|sello|tribut|comision|ingresosbrutos|suss/.test(ruta + normalizar(descripcion));
    if (!esImpositivo || importe === null) return null;
    return {
      ruta: grupo.ruta,
      concepto: descripcion || grupo.ruta.split('.').at(-1),
      codigo: valorGrupo(grupo, ['codigo','id','codigoRegimen','codigoImpuesto']),
      baseImponible: parsearNumero(valorGrupo(grupo, ['baseImponible','importeBase','baseCalculo'])),
      alicuota: parsearNumero(valorGrupo(grupo, ['alicuota','porcentaje','tasa'])),
      importe
    };
  }).filter(Boolean);
  const participantes = grupos.map(grupo => {
    const cuit = String(valorGrupo(grupo, ['cuit','cuitPersona','cuitParticipante','cuitLiquidador','cuitVendedor','cuitProductor','cuitComprador','cuitCorredor']) || '').replace(/\D/g, '');
    if (cuit.length !== 11) return null;
    return {
      rol: nombreCampo(grupo.ruta),
      cuit,
      nombre: valorGrupo(grupo, ['razonSocial','denominacion','nombre','apellidoNombre','razonSocialLiquidador','razonSocialVendedor','razonSocialProductor']) || null
    };
  }).filter(Boolean).filter((item, index, todos) => todos.findIndex(otro => otro.rol === item.rol && otro.cuit === item.cuit) === index);
  const items = grupos.map(grupo => {
    const producto = valorGrupo(grupo, ['descripcionGrano','descGrano','producto','especie','grano','descripcionProducto']);
    const kilosItem = parsearNumero(valorGrupo(grupo, ['kilosNetos','kgNetos','pesoNeto','cantidadKilos','kilogramos','kilosLiquidados']));
    const precio = parsearNumero(valorGrupo(grupo, ['precioTonelada','precioPorTonelada','precio','precioOperacion']));
    if (!producto && kilosItem === null && precio === null) return null;
    return {
      ruta: grupo.ruta,
      producto: producto || null,
      codigoProducto: valorGrupo(grupo, ['codigoGrano','codGrano','codigoProducto','codEspecie']),
      campana: valorGrupo(grupo, ['campania','campana','descripcionCampania']),
      kilos: kilosItem,
      toneladas: kilosItem === null ? null : kilosItem / 1000,
      precioTonelada: precio,
      importe: parsearNumero(valorGrupo(grupo, ['importe','importeBruto','subtotal','importeNeto']))
    };
  }).filter(Boolean);
  const kilos = numero(['kilosNetos','kgNetos','pesoNeto','cantidadKilos','kilogramos','kilosLiquidados']);
  const toneladasInformadas = numero(['toneladas','cantidadToneladas','toneladasLiquidadas']);
  const coe = encontrar(['coe','coeLiquidacion','numeroCoe']);
  const tipoDocumento = String(encontrar(['tipoDocumento']) || payload.tipoDocumento || (String(coe || '').startsWith('331') ? 'LSG' : String(coe || '').startsWith('330') ? 'LPG' : '')).toUpperCase();
  const tipoOperacion = encontrar(['tipoOperacion','descripcionOperacion','tipoLiquidacion','descripcionTipoOperacion']);
  const operacionNormalizada = normalizar(tipoOperacion);
  const tipoFormularioHistorico = /consign/.test(operacionNormalizada)
    ? '1116 C / Consignación'
    : /compraventa|comprayventa/.test(operacionNormalizada)
      ? '1116 B / Compraventa'
      : null;
  return {
    coe,
    familiaDocumento: tipoDocumento === 'LSG' ? 'Liquidación secundaria de granos (LSG)' : tipoDocumento === 'LPG' ? 'Liquidación primaria de granos (LPG)' : tipoDocumento || null,
    tipoFormularioHistorico,
    tipoOperacion,
    estado: encontrar(['estado','estadoLiquidacion']),
    liquidadorCuit: encontrar(['cuitLiquidador','cuitEmisor','cuitComprador','cuitCorredor']),
    liquidadorNombre: encontrar(['razonSocialLiquidador','denominacionLiquidador','nombreLiquidador','razonSocialEmisor']),
    receptorCuit: encontrar(['cuitVendedor','cuitProductor','cuitReceptor','cuitRepresentado']),
    receptorNombre: encontrar(['razonSocialVendedor','nombreProductor','razonSocialProductor','denominacionReceptor']),
    producto: encontrar(['descripcionGrano','descGrano','producto','especie','grano']),
    campana: encontrar(['campania','campana','descripcionCampania']),
    kilos,
    toneladas: toneladasInformadas ?? (kilos !== null ? kilos / 1000 : null),
    precioTonelada: numero(['precioTonelada','precioPorTonelada','precio','precioOperacion']),
    importeBruto: numero(['importeBruto','importeTotalBruto','subtotalBruto']),
    importeNeto: numero(['importeNeto','netoGravado','importeNetoGravado','subtotalNeto']),
    iva: numero(['importeIva','iva','montoIva']),
    sellado: numero(['sellado','impuestoSellos','importeSellos','retencionSellos']),
    retencionGanancias: numero(['retencionGanancias','importeRetencionGanancias','ganancias']),
    retencionIva: numero(['retencionIva','importeRetencionIva','ivaRetenido']),
    comisiones: numero(['comision','comisiones','importeComision']),
    otrasRetenciones: numero(['otrasRetenciones','importeOtrasRetenciones']),
    otrosConceptos: numero(['otrosConceptos','otrosTributos','gastos']),
    importeTotal: numero(['importeTotal','total','totalLiquidacion','importeNetoAPagar']),
    moneda: encontrar(['moneda','codigoMoneda','monId']),
    participantes,
    items,
    conceptosImpositivos,
    camposOficiales: campos
  };
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
  const esLiquidacion = fuente === 'WSLPG_LIQUIDACIONES';
  const conditions = [esLiquidacion
    ? `(d.fuente LIKE 'WSLPG_%' AND d.fuente NOT LIKE '%CERTIFICACION%')`
    : 'd.fuente = $1'];
  const params = esLiquidacion ? [] : [fuente];
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
           cp.cuit AS contraparte_cuit,
           EXISTS(
             SELECT 1 FROM arca_official_files f
             WHERE f.document_id=d.id AND f.file_type='PDF'
           ) AS tiene_pdf
    ${baseJoin}
    WHERE ${where}
    ORDER BY d.document_date DESC NULLS LAST, d.id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, queryParams);
  return {
    documentos: rows.map(row => {
      const payload = row.payload || {};
      const detalleLiquidacion = esLiquidacion ? detalleLiquidacionWslpg(payload) : null;
      const { rawXml, ...publicPayload } = payload;
      return {
        ...row,
        payload: { ...publicPayload, ...detalleFiscalWsfe(payload) },
        detalle_liquidacion: detalleLiquidacion,
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



async function importarCertificadoInteractivo({ coe, metadata = {}, pdfBuffer }) {
  await ensureSyncTables();
  const safeCoe = String(coe || '').replace(/\D/g, '');
  if (!/^332\d{9}$/.test(safeCoe)) {
    throw new Error('COE de certificado invalido.');
  }
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length < 5 ||
      pdfBuffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('El archivo no es un PDF valido.');
  }
  const fechaTexto = String(metadata.fecha_emision || '');
  const fechaMatch = fechaTexto.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const fecha = fechaMatch
    ? `${fechaMatch[3]}-${fechaMatch[2]}-${fechaMatch[1]}`
    : null;
  const payload = {
    ...metadata,
    coe: safeCoe,
    origen: 'SERVICIO_INTERACTIVO_ARCA',
    soloConsulta: true
  };
  const resultado = await guardarDocumentoOficial(
    'ARCA_CEG_INTERACTIVO',
    safeCoe,
    fecha,
    payload,
    pdfBuffer
  );
  return {
    coe: safeCoe,
    documentId: resultado.documentId,
    pdfGuardado: resultado.pdfGuardado,
    ctgs: Array.isArray(metadata.ctgs) ? metadata.ctgs.length : 0
  };
}

async function materializarCertificadosCtg() {
  await ensureSyncTables();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS arca_certificado_ctg_links (
      id BIGSERIAL PRIMARY KEY,
      certificado_document_id BIGINT NOT NULL
        REFERENCES arca_official_documents(id) ON DELETE CASCADE,
      certificado_coe VARCHAR(20) NOT NULL,
      ctg VARCHAR(20) NOT NULL,
      cpe_document_id BIGINT
        REFERENCES arca_official_documents(id) ON DELETE SET NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(certificado_document_id, ctg)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_arca_certificado_ctg_links_ctg
    ON arca_certificado_ctg_links(ctg)
  `);

  const { rows: certificados } = await pool.query(`
    SELECT id, external_key AS coe, payload
    FROM arca_official_documents
    WHERE fuente IN ('WSLPG_CERTIFICACION', 'WSLPG_CERTIFICACION_COE', 'ARCA_CEG_INTERACTIVO')
    ORDER BY id
  `);
  let certificadosConCtg = 0;
  let relaciones = 0;
  let vinculadas = 0;
  let pendientes = 0;

  for (const certificado of certificados) {
    const rawXml = String(certificado.payload?.rawXml || '');
    const ctgsPayload = Array.isArray(certificado.payload?.ctgs)
      ? certificado.payload.ctgs
      : [];
    const ctgs = [...new Set([...ctgsPayload, ...tags(rawXml, 'ctg')]
      .map(value => String(value || '').replace(/\D/g, ''))
      .filter(value => /^\d{8,20}$/.test(value)))];
    if (ctgs.length) certificadosConCtg += 1;

    for (const ctg of ctgs) {
      const { rows: cpes } = await pool.query(`
        SELECT id
        FROM arca_official_documents
        WHERE external_key=$1
          AND fuente IN ('WSCPE_CPE', 'WSCPE_CTG', 'WSCPE_DESTINO')
        ORDER BY CASE
          WHEN fuente='WSCPE_CPE' THEN 0
          WHEN fuente='WSCPE_CTG' THEN 1
          ELSE 2
        END, id
        LIMIT 1
      `, [ctg]);
      const cpeDocumentId = cpes[0]?.id || null;
      const estado = cpeDocumentId ? 'VINCULADO' : 'PENDIENTE';
      await pool.query(`
        INSERT INTO arca_certificado_ctg_links
          (certificado_document_id, certificado_coe, ctg, cpe_document_id, estado)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (certificado_document_id, ctg) DO UPDATE
        SET cpe_document_id=EXCLUDED.cpe_document_id,
            estado=EXCLUDED.estado,
            updated_at=NOW()
      `, [certificado.id, certificado.coe, ctg, cpeDocumentId, estado]);
      relaciones += 1;
      if (cpeDocumentId) vinculadas += 1;
      else pendientes += 1;
    }
  }

  return {
    certificadosRevisados: certificados.length,
    certificadosConCtg,
    relaciones,
    vinculadas,
    pendientes
  };
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
  consultarPadronA13,
  iniciarSyncFacturasEmitidas,
  iniciarSyncWslpg,
  iniciarSyncWslpgPdfPorCoe,
  importarWslpgPorCoe,
  iniciarSyncWslpgAjustesPorCoe,
  importarWslpgAjustesPorCoe,
  iniciarSyncCpePorCtg,
  iniciarSyncCpeDestino,
  consultarPlantasWscpe,
  consultarCpesDestinoWscpe,
  consultarCpePorCtg,
  consultarTiposGranoWscpe,
  consultarDerivadosGranariosWscpe,
  importarCpePorCtg,
  obtenerPdfDocumento,
  obtenerSyncJob,
  obtenerResumenDocumentos,
  listarDocumentosOficiales,
  resumirConciliacionContrapartes,
  resumirIvaVentas,
  listarConciliacionesCuentaCorriente,
  decidirConciliacionCuentaCorriente,
  importarCpeNormalizada,
  materializarMovimientosCpe,
  diagnosticarDerivadosPendientes,
  listarReporteCpeCertificados,
  listarReporteCpeIntervinientes,
  iniciarRefreshDerivadosPendientes,
  materializarCertificadosCtg,
  importarCertificadoInteractivo,
  productoCpeOficial,
  diagnosticarCredenciales,
  _internal: {
    productoCpeOficial,
    seleccionarPersonaReporte,
    catalogoCodigoDescripcion,
    descripcionEspecificaDerivado,
    xmlEscape,
    decodeXml,
    tag,
    tags,
    tipoWslpgPorCoe,
    solicitudWslpgPorCoe,
    solicitudAjusteWslpgPorCoe,
    parsearAjusteWslpg,
    decodificarPdfWslpg,
    payloadOficialSinPdf,
    fechaWslpg,
    wslpgBusinessError,
    detalleFiscalWsfe,
    detalleLiquidacionWslpg,
    signoComprobanteWsfe,
    xmlToObject,
    extraerIntervinientesCpe,
    extraerPlantasCpe,
    erroresWscpe,
    fechaCpe,
    normalizarCuit,
    normalizarNumeroPlanta,
    tipoContrapartePorRol,
    parsearPersonaPadronA13,
    validarFechaIso,
    rangosWscpe,
    normalizarEstadoCpe,
    esEstadoConfirmadoCpe,
    estadoCpeDesdePayload,
    clasificarOrigenCtg,
    wscpeTargets,
    getConfig,
    validateCredentials
  }
};
