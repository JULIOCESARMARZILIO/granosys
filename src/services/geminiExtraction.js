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
    response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: comprobanteSchema
      }
    });
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

module.exports = { extraerComprobante, guardarEnStaging, ExtraccionError };
