const { GoogleGenAI, Type } = require('@google/genai');
const { pool } = require('../db');

// Alias de Google que siempre apunta al Flash estable más reciente (evita hardcodear versión).
const MODEL = 'gemini-flash-latest';

class ExtraccionError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ExtraccionError';
    this.cause = cause;
  }
}

// Esquema forzado: el modelo solo puede responder con esta forma exacta.
// datos_incompletos_origen no se persiste tal cual; es la señal que dispara la regla de doble registro.
const comprobanteSchema = {
  type: Type.OBJECT,
  properties: {
    patente_camion: {
      type: Type.STRING,
      description: 'Patente del camión o acoplado que figura en el comprobante (carta de porte o ticket de balanza).'
    },
    kilos_netos: {
      type: Type.NUMBER,
      description: 'Peso neto en kilogramos descargado, según el comprobante.'
    },
    producto: {
      type: Type.STRING,
      description: 'Grano o producto: soja, maíz, girasol, trigo, etc.'
    },
    remitente_nombre: {
      type: Type.STRING,
      description: 'Nombre o razón social del productor/remitente de origen, si figura en el comprobante.'
    },
    remitente_cuit: {
      type: Type.STRING,
      description: 'CUIT del remitente de origen, formato NN-NNNNNNNN-N, si figura en el comprobante.'
    },
    contrato_destino: {
      type: Type.STRING,
      description: 'Número de contrato al que debería imputarse la descarga, si el mensaje lo menciona explícitamente.'
    },
    datos_incompletos_origen: {
      type: Type.BOOLEAN,
      description: 'true si el comprobante solo trae los datos de descarga/llegada y NO trae los datos de carga/origen (ej: falta remitente, CUIT o patente de origen distinta a la de llegada).'
    }
  },
  required: ['patente_camion', 'kilos_netos', 'producto', 'datos_incompletos_origen']
};

const PROMPT_INSTRUCCIONES = `Sos un asistente que lee comprobantes de granos (cartas de porte, tickets de balanza de descarga de camiones, o mensajes de WhatsApp de un productor/acopio) y extrae datos estructurados.

Reglas:
- Si el texto o la imagen no traen alguno de los campos opcionales, dejalo vacío ("") en vez de inventar un valor.
- "producto" debe normalizarse a minúsculas (soja, maíz, girasol, trigo, sorgo).
- Marcá datos_incompletos_origen=true únicamente cuando el comprobante es claramente solo de descarga/llegada (no trae remitente, CUIT de origen, ni patente/carta de porte de carga).`;

/**
 * Llama a Gemini con el texto y/o imagen del comprobante y devuelve el JSON estructurado,
 * ya con la regla de "doble registro" aplicada (replica destino como origen si falta ese dato).
 */
async function extraerComprobante({ texto, imagenBase64, mimeType } = {}) {
  if (!texto && !imagenBase64) {
    throw new ExtraccionError('Se requiere al menos el texto del mensaje o una imagen del comprobante.');
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new ExtraccionError('La variable de entorno GEMINI_API_KEY no está configurada.');
  }

  const parts = [];
  if (imagenBase64) {
    parts.push({ inlineData: { data: imagenBase64, mimeType: mimeType || 'image/jpeg' } });
  }
  parts.push({ text: `${PROMPT_INSTRUCCIONES}\n\nMensaje del remitente:\n${texto || '(sin texto, solo imagen adjunta)'}` });

  const ai = new GoogleGenAI({ apiKey });

  let response;
  try {
    const request = ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: comprobanteSchema
      }
    });
    response = await Promise.race([
      request,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout de 90 segundos')), 90000))
    ]);
  } catch (err) {
    throw new ExtraccionError(`No se pudo invocar la API de Gemini: ${err.message}`, err);
  }

  const rawText = response?.text;
  if (!rawText) {
    throw new ExtraccionError('Gemini no devolvió contenido (posible bloqueo de seguridad o imagen ilegible).');
  }

  let datos;
  try {
    datos = JSON.parse(rawText);
  } catch (err) {
    throw new ExtraccionError(`Gemini devolvió un JSON malformado: ${rawText.slice(0, 300)}`, err);
  }

  if (!datos.patente_camion || !datos.kilos_netos || !datos.producto) {
    throw new ExtraccionError('Gemini no pudo identificar patente, kilos netos o producto en el comprobante.');
  }

  // Regla de negocio (doble registro): si falta el dato de carga/origen, replicamos el de descarga/llegada.
  const dobleRegistroAplicado = Boolean(datos.datos_incompletos_origen);

  return {
    patente_camion: datos.patente_camion,
    kilos_netos: Number(datos.kilos_netos),
    producto: datos.producto,
    remitente_nombre: datos.remitente_nombre || null,
    remitente_cuit: datos.remitente_cuit || null,
    contrato_destino: datos.contrato_destino || null,
    doble_registro_aplicado: dobleRegistroAplicado,
    raw: datos
  };
}

/**
 * Inserta el resultado extraído en staging_movimientos con estado Pendiente_Autorizacion.
 * Nunca escribe en las tablas de producción (movimientos, contratos, etc.).
 */
async function guardarEnStaging(datosExtraidos, meta = {}) {
  const { rows } = await pool.query(
    `INSERT INTO staging_movimientos
      (telefono_remitente, mensaje_texto, patente_camion, kilos_netos, producto,
       remitente_nombre, remitente_cuit, contrato_destino, doble_registro_aplicado,
       datos_extraidos_raw, media_url, estado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Pendiente_Autorizacion')
     RETURNING *`,
    [
      meta.telefonoRemitente || null,
      meta.mensajeTexto || null,
      datosExtraidos.patente_camion,
      datosExtraidos.kilos_netos,
      datosExtraidos.producto,
      datosExtraidos.remitente_nombre,
      datosExtraidos.remitente_cuit,
      datosExtraidos.contrato_destino,
      datosExtraidos.doble_registro_aplicado,
      JSON.stringify(datosExtraidos.raw),
      meta.mediaUrl || null
    ]
  );
  return rows[0];
}

// Esquema de la Carta de Porte Electrónica (AFIP). Mismos nombres de campo que usaba
// el parser por regex (parseCpeText en el frontend), para que el formulario no cambie.
const cpeSchema = {
  type: Type.OBJECT,
  properties: {
    nro_ctg: { type: Type.STRING, description: 'Número de CTG (Código de Trazabilidad de Granos).' },
    nro_cpe: { type: Type.STRING, description: 'Número de CPE, formato NNNNN-NNNNNNNN.' },
    fecha: { type: Type.STRING, description: 'Fecha de emisión de la CPE, formato DD/MM/AAAA.' },
    fecha_iso: { type: Type.STRING, description: 'La misma fecha de emisión en formato AAAA-MM-DD.' },
    vencimiento: { type: Type.STRING, description: 'Fecha de vencimiento de la CPE, formato DD/MM/AAAA.' },
    vencimiento_iso: { type: Type.STRING, description: 'La misma fecha de vencimiento en formato AAAA-MM-DD.' },
    titular: { type: Type.STRING, description: 'Nombre del titular de la CPE (primer CUIT-nombre listado antes de "Destinatario").' },
    titular_cuit: { type: Type.STRING, description: 'CUIT del titular.' },
    rte_primaria: { type: Type.STRING, description: 'Remitente comercial productor (segundo CUIT-nombre antes de "Destinatario").' },
    rte_primaria_cuit: { type: Type.STRING, description: 'CUIT del remitente comercial productor.' },
    rte_venta_primaria: { type: Type.STRING, description: 'Remitente comercial venta primaria (tercer CUIT-nombre antes de "Destinatario").' },
    rte_venta_primaria_cuit: { type: Type.STRING, description: 'CUIT del remitente comercial venta primaria.' },
    destinatario: { type: Type.STRING, description: 'Nombre del destinatario de la carga.' },
    destinatario_cuit: { type: Type.STRING, description: 'CUIT del destinatario.' },
    destino: { type: Type.STRING, description: 'Nombre del destino/planta de descarga.' },
    destino_cuit: { type: Type.STRING, description: 'CUIT del destino.' },
    transportista: { type: Type.STRING, description: 'Nombre de la empresa transportista.' },
    transportista_cuit: { type: Type.STRING, description: 'CUIT de la empresa transportista.' },
    chofer: { type: Type.STRING, description: 'Nombre del chofer.' },
    chofer_cuit: { type: Type.STRING, description: 'CUIT/CUIL del chofer.' },
    flete_pagador: { type: Type.STRING, description: 'Nombre de quien paga el flete.' },
    flete_pagador_cuit: { type: Type.STRING, description: 'CUIT de quien paga el flete.' },
    especie: { type: Type.STRING, description: 'Grano transportado: Soja, Maíz, Trigo, Girasol, Cebada o Sorgo.' },
    campana: { type: Type.STRING, description: 'Campaña agrícola, formato "20XX/20YY".' },
    peso_bruto: { type: Type.NUMBER, description: 'Peso bruto en kilogramos.' },
    peso_tara: { type: Type.NUMBER, description: 'Peso tara en kilogramos.' },
    peso_neto: { type: Type.NUMBER, description: 'Peso neto en kilogramos (bruto - tara).' },
    chasis: { type: Type.STRING, description: 'Patente del camión/chasis.' },
    acoplado: { type: Type.STRING, description: 'Patente del acoplado.' },
    km: { type: Type.NUMBER, description: 'Kilómetros a recorrer declarados.' },
    origen_planta: { type: Type.STRING, description: 'Número de planta/campo de origen, sección C - PROCEDENCIA.' },
    origen_direccion: { type: Type.STRING, description: 'Dirección de origen, sección C - PROCEDENCIA.' },
    origen_prov: { type: Type.STRING, description: 'Provincia de origen (nombre propio, ej: "Santa Fe").' },
    origen_loc: { type: Type.STRING, description: 'Localidad de origen.' },
    latitud: { type: Type.STRING, description: 'Latitud del campo de origen, si figura.' },
    longitud: { type: Type.STRING, description: 'Longitud del campo de origen, si figura.' },
    nro_planta: { type: Type.STRING, description: 'Número de planta de destino, sección D - DESTINO DE LA MERCADERÍA.' },
    destino_direccion: { type: Type.STRING, description: 'Dirección de destino, sección D - DESTINO DE LA MERCADERÍA.' },
    destino_prov: { type: Type.STRING, description: 'Provincia de destino (nombre propio, ej: "Buenos Aires").' },
    destino_loc: { type: Type.STRING, description: 'Localidad de destino.' },
    renspa: { type: Type.STRING, description: 'RENSPA del campo de origen, si figura.' }
  },
  required: []
};

const PROMPT_CPE = `Sos un asistente que lee el texto de una Carta de Porte Electrónica (CPE) argentina emitida por AFIP/ARCA (formulario de trazabilidad de granos) y extrae datos estructurados exactamente con el esquema pedido.

Reglas:
- Si un campo no figura en el texto, dejalo vacío ("" para texto, 0 para número) en vez de inventar un valor.
- "especie" debe normalizarse con la primera letra mayúscula (Soja, Maíz, Trigo, Girasol, Cebada, Sorgo).
- Provincias en "origen_prov"/"destino_prov" deben quedar con formato de nombre propio (ej: "Santa Fe", no "SANTA FE").
- El texto viene de una extracción de PDF y puede tener saltos de línea irregulares o texto entremezclado; usá el contexto (secciones, etiquetas como "Destinatario:", "Empresa Transportista:", "C - PROCEDENCIA", "D - DESTINO DE LA MERCADERÍA") para ubicar cada dato.`;

const datoVisibleSchema = {
  type: Type.OBJECT,
  properties: {
    etiqueta: { type: Type.STRING },
    valor: { type: Type.STRING },
    seccion: { type: Type.STRING }
  },
  required: ['etiqueta', 'valor', 'seccion']
};

const calidadCertificadoSchema = {
  type: Type.OBJECT,
  properties: {
    parametro: { type: Type.STRING },
    valor: { type: Type.NUMBER },
    unidad: { type: Type.STRING },
    observacion: { type: Type.STRING }
  },
  required: ['parametro', 'valor', 'unidad', 'observacion']
};

const camionCertificadoSchema = {
  type: Type.OBJECT,
  properties: {
    ctg: { type: Type.STRING }, nro_cpe: { type: Type.STRING }, fecha_carga: { type: Type.STRING },
    fecha_descarga: { type: Type.STRING }, patente_chasis: { type: Type.STRING }, patente_acoplado: { type: Type.STRING },
    kilos_brutos_descargados: { type: Type.NUMBER }, kilos_tara: { type: Type.NUMBER },
    kilos_netos_descargados: { type: Type.NUMBER }, kilos_netos_acondicionados: { type: Type.NUMBER },
    merma_humedad_kg: { type: Type.NUMBER }, merma_calidad_kg: { type: Type.NUMBER },
    otras_mermas_kg: { type: Type.NUMBER }, humedad_pct: { type: Type.NUMBER },
    calidades: { type: Type.ARRAY, items: calidadCertificadoSchema },
    datos_adicionales: { type: Type.ARRAY, items: datoVisibleSchema }
  },
  required: []
};

const certificadoPdfSchema = {
  type: Type.OBJECT,
  properties: {
    coe: { type: Type.STRING }, numero_certificado: { type: Type.STRING }, tipo_formulario: { type: Type.STRING },
    fecha_emision: { type: Type.STRING }, emisor_nombre: { type: Type.STRING }, emisor_cuit: { type: Type.STRING },
    comprador_nombre: { type: Type.STRING }, comprador_cuit: { type: Type.STRING },
    productor_nombre: { type: Type.STRING }, productor_cuit: { type: Type.STRING },
    depositante_nombre: { type: Type.STRING }, depositante_cuit: { type: Type.STRING },
    depositario_nombre: { type: Type.STRING }, depositario_cuit: { type: Type.STRING },
    corredor_nombre: { type: Type.STRING }, corredor_cuit: { type: Type.STRING },
    especie: { type: Type.STRING }, campana: { type: Type.STRING }, grado: { type: Type.STRING },
    planta: { type: Type.STRING }, nro_planta: { type: Type.STRING }, localidad: { type: Type.STRING },
    provincia: { type: Type.STRING }, direccion: { type: Type.STRING }, contrato_referencia: { type: Type.STRING },
    kilos_brutos_certificados: { type: Type.NUMBER }, kilos_netos_acondicionados: { type: Type.NUMBER },
    merma_humedad_kg: { type: Type.NUMBER }, merma_calidad_kg: { type: Type.NUMBER },
    otras_mermas_kg: { type: Type.NUMBER },
    calidades: { type: Type.ARRAY, items: calidadCertificadoSchema },
    camiones: { type: Type.ARRAY, items: camionCertificadoSchema },
    datos_adicionales: { type: Type.ARRAY, items: datoVisibleSchema },
    observaciones_lectura: { type: Type.ARRAY, items: { type: Type.STRING } }
  },
  required: []
};

const PROMPT_CERTIFICADO_PDF = `Leé este PDF completo de un certificado de depósito de granos argentino y transcribí la mayor cantidad posible de datos estructurados.
Reglas estrictas:
- Extraé solamente datos visibles en el PDF. No infieras, calcules ni inventes valores ausentes.
- El emisor puede ser el comprador, pero asigná cada rol únicamente según su etiqueta o evidencia documental.
- Conservá cada CTG/camión por separado con descarga, neto acondicionado, mermas y calidades cuando el PDF los discrimine.
- Los pesos son kilogramos. Un campo numérico ausente debe quedar sin informar, no en datos_adicionales.
- Usá datos_adicionales para cualquier otro campo legible que no tenga campo propio, indicando la sección.
- Si un dato es ambiguo o ilegible, no lo adivines: describilo brevemente en observaciones_lectura.`;

async function extraerCertificadoPdf(pdfBuffer) {
  if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.length) throw new ExtraccionError('Se requiere el PDF del certificado.');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new ExtraccionError('La variable de entorno GEMINI_API_KEY no está configurada.');
  const ai = new GoogleGenAI({ apiKey });
  let response;
  try {
    const request = ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [
        { inlineData: { data: pdfBuffer.toString('base64'), mimeType: 'application/pdf' } },
        { text: PROMPT_CERTIFICADO_PDF }
      ] }],
      config: { responseMimeType: 'application/json', responseSchema: certificadoPdfSchema }
    });
    response = await Promise.race([
      request,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout de 90 segundos')), 90000))
    ]);
  } catch (err) {
    throw new ExtraccionError(`No se pudo invocar Gemini para el certificado: ${err.message}`, err);
  }
  if (!response?.text) throw new ExtraccionError('Gemini no devolvió contenido para el certificado.');
  try { return JSON.parse(response.text); }
  catch (err) { throw new ExtraccionError(`Gemini devolvió JSON malformado: ${response.text.slice(0, 300)}`, err); }
}

/**
 * Extrae los datos estructurados de una Carta de Porte Electrónica a partir del texto
 * plano ya extraído del PDF en el cliente (pdf.js). No reemplaza la extracción de texto,
 * solo la interpretación/estructuración de campos (antes hecha con regex).
 */
async function extraerDatosCPE(texto) {
  if (!texto || !texto.trim()) {
    throw new ExtraccionError('Se requiere el texto extraído del PDF de la CPE.');
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new ExtraccionError('La variable de entorno GEMINI_API_KEY no está configurada.');
  }

  const ai = new GoogleGenAI({ apiKey });

  let response;
  try {
    response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: `${PROMPT_CPE}\n\nTexto extraído del PDF:\n${texto}` }] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: cpeSchema
      }
    });
  } catch (err) {
    throw new ExtraccionError(`No se pudo invocar la API de Gemini: ${err.message}`, err);
  }

  const rawText = response?.text;
  if (!rawText) {
    throw new ExtraccionError('Gemini no devolvió contenido (posible bloqueo de seguridad o PDF ilegible).');
  }

  try {
    return JSON.parse(rawText);
  } catch (err) {
    throw new ExtraccionError(`Gemini devolvió un JSON malformado: ${rawText.slice(0, 300)}`, err);
  }
}

module.exports = { extraerComprobante, guardarEnStaging, extraerDatosCPE, extraerCertificadoPdf, ExtraccionError, MODEL };
