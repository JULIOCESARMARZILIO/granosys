const router = require('express').Router();
const arcaService = require('../services/arcaService');

// Auxiliar para saber el modo actual de conexión
function getModoConexion() {
  const afipCuit = process.env.AFIP_CUIT;
  const afipCert = process.env.AFIP_CERT;
  const afipKey = process.env.AFIP_KEY;

  if (!afipCuit || !afipCert || !afipKey) {
    return 'SIMULADOR / MOCK';
  }
  return process.env.AFIP_PROD === 'true' ? 'PRODUCCION' : 'HOMOLOGACION';
}

// 1. GET Estado de conexión general a los 7 servicios web
router.get('/status', async (req, res) => {
  const modo = getModoConexion();
  const servicios = [
    { id: 'wscpe', nombre: 'Monit. Cartas de Porte (WSCPE)', descripcion: 'Logística de grano en tránsito', estado: modo === 'SIMULADOR / MOCK' ? 'TESTING' : 'OK' },
    { id: 'ws_sr_padron_a13', nombre: 'Padrón Contribuyentes (A13)', descripcion: 'Validación fiscal de CUITs', estado: modo === 'SIMULADOR / MOCK' ? 'TESTING' : 'OK' },
    { id: 'sisa', nombre: 'Scoring Agrícola (SISA)', descripcion: 'Cálculo de retenciones de IVA/Ganancias', estado: modo === 'SIMULADOR / MOCK' ? 'TESTING' : 'OK' },
    { id: 'wslpg', nombre: 'Liquidación Primaria (WSLPG)', descripcion: 'Emisión de LPG con firma y CAE', estado: modo === 'SIMULADOR / MOCK' ? 'TESTING' : 'OK' },
    { id: 'ws_certificacion_granos', nombre: 'Movimientos Físicos (1116)', descripcion: 'Stock físico y COE de Balanza', estado: modo === 'SIMULADOR / MOCK' ? 'TESTING' : 'OK' },
    { id: 'wsfe', nombre: 'Facturación Electrónica (WSFE)', descripcion: 'Facturas de venta y MiPyMEs', estado: modo === 'SIMULADOR / MOCK' ? 'TESTING' : 'OK' }
  ];

  res.json({
    modo_conexion: modo,
    cuit_empresa: process.env.AFIP_CUIT || "30710206194 (Mock)",
    servicios,
    timestamp: new Date().toISOString()
  });
});

// 2. GET Listado de Cartas de Porte en tránsito
router.get('/cpe', async (req, res) => {
  try {
    const data = await arcaService.consultarCPEsActivas();
    res.json({
      modo: getModoConexion(),
      total_activas: data.length,
      cartas_de_porte: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. GET Datos extendidos de Padrón A13 por CUIT
router.get('/padron/:cuit', async (req, res) => {
  try {
    const data = await arcaService.consultarPadronA13(req.params.cuit);
    res.json({
      modo: getModoConexion(),
      cuit_consultado: req.params.cuit,
      contribuyente: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. GET Scoring y retenciones SISA por CUIT
router.get('/sisa/:cuit', async (req, res) => {
  try {
    const data = await arcaService.consultarSISA(req.params.cuit);
    res.json({
      modo: getModoConexion(),
      cuit_consultado: req.params.cuit,
      sisa: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. POST Procesar Liquidación Primaria de Granos (WSLPG)
router.post('/lpg', async (req, res) => {
  try {
    const data = await arcaService.emitirLiquidacionLPG(req.body);
    res.json({
      modo: getModoConexion(),
      resultado: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. POST Emitir Certificado 1116 de Balanza
router.post('/certificado-1116', async (req, res) => {
  try {
    const { tipo, datos } = req.body;
    if (!tipo || !['A', 'B', 'C'].includes(tipo.toUpperCase())) {
      return res.status(400).json({ error: 'El tipo de formulario 1116 debe ser A, B o C' });
    }
    const data = await arcaService.emitirCertificado1116(tipo.toUpperCase(), datos || {});
    res.json({
      modo: getModoConexion(),
      resultado: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. POST Emitir Factura Electrónica
router.post('/factura', async (req, res) => {
  try {
    const data = await arcaService.emitirFacturaElectronica(req.body);
    res.json({
      modo: getModoConexion(),
      resultado: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. GET Consultar comprobante emitido
router.get('/comprobante', async (req, res) => {
  try {
    const { tipo, puntoVenta, numero } = req.query;
    if (!tipo || !puntoVenta || !numero) {
      return res.status(400).json({ error: 'Parámetros obligatorios faltantes: tipo, puntoVenta, numero' });
    }
    const data = await arcaService.consultarComprobanteEmitido(
      parseInt(tipo),
      parseInt(puntoVenta),
      parseInt(numero)
    );
    res.json({
      modo: getModoConexion(),
      comprobante: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
