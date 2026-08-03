const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const ticketCache = new Map();

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
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset=utf-8',
      SOAPAction: action
    },
    body,
    signal: AbortSignal.timeout(30000)
  });
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
  return ticket;
}

async function wslpgDummy() {
  const config = getConfig();
  const ticket = await getTicket('wslpg');
  const url = config.production
    ? 'https://serviciosjava.arca.gob.ar/wslpg/LpgService'
    : 'https://fwshomo.afip.gov.ar/wslpg/LpgService';
  // La implementaciÃ³n productiva exige autenticaciÃ³n aun para dummy.
  // LpgAuthType define el campo como "cuit" (no "cuitRepresentada").
  const namespace = config.production
    ? 'http://serviciosjava.arca.gob.ar/wslpg/'
    : 'http://serviciosjava.afip.gob.ar/wslpg/';
  const envelope = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:lpg="${namespace}"><soapenv:Header/><soapenv:Body><lpg:dummy><auth><token>${xmlEscape(ticket.token)}</token><sign>${xmlEscape(ticket.sign)}</sign><cuit>${config.cuit}</cuit></auth></lpg:dummy></soapenv:Body></soapenv:Envelope>`;
  const response = await soapPost(url, '', envelope);
  return {
    appServer: tag(response, 'appserver') || tag(response, 'appServer'),
    dbServer: tag(response, 'dbserver') || tag(response, 'dbServer'),
    authServer: tag(response, 'authserver') || tag(response, 'authServer')
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

module.exports = {
  getTicket,
  wslpgDummy,
  diagnosticarWslpg,
  _internal: { xmlEscape, decodeXml, tag, getConfig, validateCredentials }
};
