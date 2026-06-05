const Afip = require('@afipsdk/afip.js');
const fs = require('fs');
const path = require('path');

// Helper para obtener credenciales de ARCA
function obtenerCredenciales() {
  const afipCuit = process.env.AFIP_CUIT;
  const afipCertStr = process.env.AFIP_CERT;
  const afipKeyStr = process.env.AFIP_KEY;

  if (!afipCuit || !afipCertStr || !afipKeyStr) {
    return null; // Devuelve null si falta alguna credencial, activando el modo simulador
  }

  const certPath = path.join(__dirname, '../../afip.crt');
  const keyPath = path.join(__dirname, '../../afip.key');

  try {
    if (afipCertStr.includes('-----BEGIN')) {
      fs.writeFileSync(certPath, afipCertStr.trim());
    }
    if (afipKeyStr.includes('-----BEGIN')) {
      fs.writeFileSync(keyPath, afipKeyStr.trim());
    }
    return { cuit: afipCuit, cert: certPath, key: keyPath };
  } catch (e) {
    console.error('Error al preparar archivos de credenciales:', e);
    return null;
  }
}

// 1. Monitoreo de Cartas de Porte Electrónicas (WSCPE)
async function consultarCPEsActivas(filtro = {}) {
  const creds = obtenerCredenciales();
  if (!creds) {
    // Retornar simulación de Cartas de Porte en Tránsito
    await new Promise(r => setTimeout(r, 600));
    return [
      {
        numero_cpe: "700000001234",
        nro_ctg: "10129526726",
        fecha_emision: new Date().toISOString().split('T')[0],
        cuit_remitente: "30546687065",
        remitente: "YPF S.A. (Acopio Agro)",
        cuit_destinatario: creds ? creds.cuit : "30710206194",
        destinatario: "GranoSYS Planta Propia",
        grano: "Soja",
        kilos_estimados: 34500,
        patente_chasis: "AF123JK",
        patente_acoplado: "AD456OP",
        chofer: "Gómez Héctor Raúl",
        cuit_chofer: "20281234567",
        estado: "ACTIVA (En Tránsito)",
        origen: "Bandera, Santiago del Estero",
        destino: "Planta Propia, Sgo. del Estero"
      },
      {
        numero_cpe: "700000001235",
        nro_ctg: "10129526727",
        fecha_emision: new Date().toISOString().split('T')[0],
        cuit_remitente: "20182345678",
        remitente: "Martínez Juan Carlos",
        cuit_destinatario: creds ? creds.cuit : "30710206194",
        destinatario: "GranoSYS Planta Propia",
        grano: "Maíz",
        kilos_estimados: 29800,
        patente_chasis: "AE987HJ",
        patente_acoplado: "AC654RT",
        chofer: "Peralta Luis Alberto",
        cuit_chofer: "20245678901",
        estado: "ACTIVA (En Tránsito)",
        origen: "Sachayoj, Santiago del Estero",
        destino: "Planta Propia, Sgo. del Estero"
      }
    ];
  }

  try {
    const afip = new Afip({ CUIT: parseInt(creds.cuit), cert: creds.cert, key: creds.key, production: process.env.AFIP_PROD === 'true' });
    const wscpe = afip.WebService('wscpe');
    // Consulta real a WSCPE usando SOAP
    // Métodos del servicio: consultarCpeDestinatario, etc.
    const res = await wscpe.executeRequest('consultarCpeDestinatario', {
      cuitDestinatario: parseInt(creds.cuit),
      estado: 'AC' // Activa
    });
    return res;
  } catch (err) {
    console.error('Error real en WSCPE:', err);
    throw err;
  }
}

// 2. Consulta de Padrón Alcance 13 (ws_sr_padron_a13)
async function consultarPadronA13(cuitConsultar) {
  const creds = obtenerCredenciales();
  const cuitLimpio = cuitConsultar.replace(/[^0-9]/g, '');

  if (!creds) {
    // Simulación del Padrón Alcance 13
    await new Promise(r => setTimeout(r, 500));
    return {
      cuit: cuitLimpio,
      razon_social: cuitLimpio.startsWith('30') ? "Compañía de Granos del Norte S.A." : "Pérez Roberto Carlos",
      tipo_persona: cuitLimpio.startsWith('30') ? "JURIDICA" : "FISICA",
      estado_cuit: "ACTIVO",
      condicion_iva: cuitLimpio.startsWith('30') ? "RESPONSABLE_INSCRIPTO" : "MONOTRIBUTISTA",
      domicilio_fiscal: {
        direccion: "Ruta Nacional 34, Km 1150",
        localidad: "La Banda",
        provincia: "Santiago del Estero",
        codigo_postal: "4300"
      },
      actividades: [
        { codigo: 11112, descripcion: "Cultivo de cereales (excepto trigo y arroz) y forrajeras" },
        { codigo: 462110, descripcion: "Venta al por mayor de materias primas agrícolas y de la silvicultura" }
      ],
      impuestos: [
        { id: 20, descripcion: "Monotributo", estado: "ACTIVO" },
        { id: 10, descripcion: "IVA", estado: "ACTIVO" },
        { id: 1030, descripcion: "Ganancias Sociedades", estado: "ACTIVO" }
      ]
    };
  }

  try {
    const afip = new Afip({ CUIT: parseInt(creds.cuit), cert: creds.cert, key: creds.key, production: process.env.AFIP_PROD === 'true' });
    // ws_sr_padron_a13 implementado vía SOAP genérico
    const ws = afip.WebService('ws_sr_padron_a13');
    const res = await ws.executeRequest('getPersona_v13', {
      cuitRepresentada: parseInt(creds.cuit),
      idPersona: parseInt(cuitLimpio)
    });
    return res;
  } catch (err) {
    console.error('Error real en Padrón A13:', err);
    throw err;
  }
}

// 3. Consulta de scoring SISA (Sistema de Información Simplificado Agrícola)
async function consultarSISA(cuitConsultar) {
  const creds = obtenerCredenciales();
  const cuitLimpio = cuitConsultar.replace(/[^0-9]/g, '');

  if (!creds) {
    await new Promise(r => setTimeout(r, 400));
    // Simulación del Scoring SISA
    // El Scoring define si se retiene IVA completo (Estado 3) o si hay reintegros (Estado 1)
    let estado = "Estado 1 - Riesgo Bajo (Beneficios de reintegro de IVA e Imp. a las Ganancias)";
    let codigoEstado = 1;
    let alicuotaRetencionIva = 2.0; // 2% para Estado 1
    let alicuotaRetencionGanancias = 2.0; // 2% para Estado 1

    if (cuitLimpio.endsWith('2')) {
      estado = "Estado 2 - Riesgo Medio (Retención intermedia)";
      codigoEstado = 2;
      alicuotaRetencionIva = 8.0;
      alicuotaRetencionGanancias = 4.0;
    } else if (cuitLimpio.endsWith('3')) {
      estado = "Estado 3 - Riesgo Alto / Suspendido (Retención total de impuestos)";
      codigoEstado = 3;
      alicuotaRetencionIva = 100.0; // 100% de retención
      alicuotaRetencionGanancias = 15.0;
    }

    return {
      cuit: cuitLimpio,
      sisa_estado: estado,
      codigo_estado: codigoEstado,
      actividades_granos: "INSCRIPTO (Productor)",
      alicuota_retencion_iva: alicuotaRetencionIva,
      alicuota_retencion_ganancias: alicuotaRetencionGanancias,
      beneficios_activos: codigoEstado === 1 ? "Reintegro sistemático del 5%" : "Ninguno",
      ultima_actualizacion: new Date().toISOString().split('T')[0]
    };
  }

  try {
    const afip = new Afip({ CUIT: parseInt(creds.cuit), cert: creds.cert, key: creds.key, production: process.env.AFIP_PROD === 'true' });
    const ws = afip.WebService('sisa');
    const res = await ws.executeRequest('consultarSisaProductor', {
      cuitConsultada: parseInt(cuitLimpio)
    });
    return res;
  } catch (err) {
    console.error('Error real en SISA:', err);
    throw err;
  }
}

// 4. Liquidaciones de Granos (WSLPG - Liquidación Primaria de Granos)
async function emitirLiquidacionLPG(datos) {
  const creds = obtenerCredenciales();
  if (!creds) {
    await new Promise(r => setTimeout(r, 800));
    const randomLpgNum = Math.floor(10000000 + Math.random() * 90000000);
    return {
      success: true,
      nro_liquidacion_arca: `LPG-A-${randomLpgNum}`,
      cae: `CAE-${randomLpgNum}9876`,
      fecha_vencimiento_cae: new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0],
      total_operacion: datos.total_operacion || 9750000,
      total_retenciones_iva: datos.retencion_iva || 195000,
      total_neto: datos.total_neto || 9555000,
      mensaje: "✓ Comprobante Autorizado por ARCA (Modo Simulador)",
      fecha_proceso: new Date().toISOString()
    };
  }

  try {
    const afip = new Afip({ CUIT: parseInt(creds.cuit), cert: creds.cert, key: creds.key, production: process.env.AFIP_PROD === 'true' });
    const wslpg = afip.WebService('wslpg');
    const res = await wslpg.executeRequest('autorizarLiquidacion', {
      cabecera: {
        cuitEmisor: parseInt(creds.cuit),
        tipoComprobante: datos.tipoComprobante || 33 // 33 es LPG
      },
      detalle: datos.detalle
    });
    return res;
  } catch (err) {
    console.error('Error real en WSLPG:', err);
    throw err;
  }
}

// 5. Certificados Físicos de Granos (Formularios 1116 A/B/C)
async function emitirCertificado1116(tipo, datos) {
  const creds = obtenerCredenciales();
  if (!creds) {
    await new Promise(r => setTimeout(r, 700));
    const randomCoe = Math.floor(20000000 + Math.random() * 80000000);
    return {
      success: true,
      tipo_formulario: `1116/${tipo}`, // A, B o C
      coe: `COE-${randomCoe}`,
      numero_certificado: `CERT-${tipo}-${randomCoe}`,
      productor_cuit: datos.productor_cuit || "20182345678",
      especie: datos.especie || "Soja",
      kilos_netos: datos.kilos_netos || 30000,
      mensaje: `✓ Certificado 1116/${tipo} Emitido y Registrado Física en Balanza (Modo Simulador)`,
      fecha_emision: new Date().toISOString().split('T')[0]
    };
  }

  try {
    const afip = new Afip({ CUIT: parseInt(creds.cuit), cert: creds.cert, key: creds.key, production: process.env.AFIP_PROD === 'true' });
    const ws = afip.WebService('ws_certificacion_granos');
    const res = await ws.executeRequest('registrarCertificado1116', {
      tipoFormulario: tipo,
      datosCertificado: datos
    });
    return res;
  } catch (err) {
    console.error('Error real en Certificación 1116:', err);
    throw err;
  }
}

// 6. Facturas Electrónicas Generales (WSFE - wsfev1)
async function emitirFacturaElectronica(datos) {
  const creds = obtenerCredenciales();
  if (!creds) {
    await new Promise(r => setTimeout(r, 600));
    const randomCae = Math.floor(50000000 + Math.random() * 50000000);
    return {
      success: true,
      nro_comprobante: datos.nro_comprobante || "0001-00001245",
      cae: `CAE-${randomCae}`,
      fecha_vencimiento_cae: new Date(Date.now() + 10*24*60*60*1000).toISOString().split('T')[0],
      total: datos.total || 45000,
      tipo: datos.tipo || "A",
      mensaje: "✓ Factura Autorizada Electrónicamente en ARCA (Modo Simulador)"
    };
  }

  try {
    const afip = new Afip({ CUIT: parseInt(creds.cuit), cert: creds.cert, key: creds.key, production: process.env.AFIP_PROD === 'true' });
    // Usar el helper nativo de ElectronicBilling del SDK de Afip
    const lastVoucher = await afip.ElectronicBilling.getLastVoucher(datos.puntoVenta || 1, datos.tipoComp || 1);
    const nextVoucher = lastVoucher + 1;

    const res = await afip.ElectronicBilling.createVoucher({
      CantReg: 1,
      PtoVta: datos.puntoVenta || 1,
      CbteTipo: datos.tipoComp || 1, // 1 es Factura A
      Concepto: datos.concepto || 1, // 1 es Productos
      DocTipo: datos.docTipo || 80, // 80 es CUIT
      DocNro: parseInt(datos.docNro),
      CbteDesde: nextVoucher,
      CbteHasta: nextVoucher,
      CbteFch: new Date().toISOString().split('T')[0].replace(/-/g, ''),
      ImpTotal: datos.total,
      ImpTotConc: 0,
      ImpNeto: datos.neto,
      ImpOpEx: 0,
      ImpTrib: 0,
      ImpIVA: datos.iva,
      FchServDesde: null,
      FchServHasta: null,
      FchVtoPago: null,
      MonId: 'PES',
      MonCotiz: 1,
      Iva: [
        {
          Id: datos.ivaId || 5, // 5 es 21%
          BaseImp: datos.neto,
          Importe: datos.iva
        }
      ]
    });
    return { success: true, ...res, nro_comprobante: `${datos.puntoVenta || 1}-${nextVoucher}` };
  } catch (err) {
    console.error('Error real en WSFE:', err);
    throw err;
  }
}

// 7. Consulta de Facturas Emitidas / Recibidas y MiPyMEs
async function consultarComprobanteEmitido(tipo, ptoVta, nro) {
  const creds = obtenerCredenciales();
  if (!creds) {
    await new Promise(r => setTimeout(r, 450));
    return {
      success: true,
      cae: "CAE-502910392019",
      fecha: new Date().toISOString().split('T')[0],
      tipoComprobante: tipo === 1 ? "Factura A" : "Factura B",
      puntoVenta: ptoVta,
      numero: nro,
      cuit_receptor: "30500000001",
      razon_social_receptor: "Cliente de Consulta S.A.",
      importe_neto: 10000,
      importe_iva: 2100,
      importe_total: 12100,
      estado_mipyme: "MIPYME_ACEPTADA"
    };
  }

  try {
    const afip = new Afip({ CUIT: parseInt(creds.cuit), cert: creds.cert, key: creds.key, production: process.env.AFIP_PROD === 'true' });
    const res = await afip.ElectronicBilling.getVoucherInfo(nro, ptoVta, tipo);
    return res;
  } catch (err) {
    console.error('Error real al consultar comprobante:', err);
    throw err;
  }
}

// Exportar todos los servicios de forma limpia
module.exports = {
  consultarCPEsActivas,
  consultarPadronA13,
  consultarSISA,
  emitirLiquidacionLPG,
  emitirCertificado1116,
  emitirFacturaElectronica,
  consultarComprobanteEmitido
};
