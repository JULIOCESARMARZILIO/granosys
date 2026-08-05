const router = require('express').Router();
const arcaService = require('../services/arcaService');
const arcaOfficialClient = require('../services/arcaOfficialClient');

// Auxiliar para saber el modo actual de conexiÃ³n
function getModoConexion() {
  return arcaService.getArcaMode();
}

// 1. GET Estado de conexiÃ³n general a los 7 servicios web
router.get('/status', async (req, res) => {
  const modo = getModoConexion();
  const servicios = [
    { id: 'wscpe', nombre: 'Monit. Cartas de Porte (WSCPE)', descripcion: 'LogÃ­stica de grano en trÃ¡nsito', estado: modo },
    { id: 'ws_sr_padron_a13', nombre: 'PadrÃ³n Contribuyentes (A13)', descripcion: 'ValidaciÃ³n fiscal de CUITs', estado: modo },
    { id: 'sisa', nombre: 'Scoring AgrÃ­cola (SISA)', descripcion: 'CÃ¡lculo de retenciones de IVA/Ganancias', estado: modo },
    { id: 'wslpg', nombre: 'LiquidaciÃ³n Primaria (WSLPG)', descripcion: 'EmisiÃ³n de LPG con firma y CAE', estado: modo },
    { id: 'ws_certificacion_granos', nombre: 'Movimientos FÃ­sicos (1116)', descripcion: 'Stock fÃ­sico y COE de Balanza', estado: modo },
    { id: 'wsfe', nombre: 'FacturaciÃ³n ElectrÃ³nica (WSFE)', descripcion: 'Facturas de venta y MiPyMEs', estado: modo }
  ];

  res.json({
    modo_conexion: modo,
    cuit_empresa: process.env.AFIP_CUIT || null,
    servicios,
    timestamp: new Date().toISOString()
  });
});

// DiagnÃ³stico oficial de solo lectura: valida certificado, obtiene TA de WSAA
// y ejecuta dummy de WSLPG. Nunca emite, ajusta ni anula comprobantes.
router.get('/diagnostico/wslpg', async (req, res) => {
  try {
    const resultado = await arcaOfficialClient.diagnosticarWslpg();
    res.json({ ok: true, resultado, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('DiagnÃ³stico oficial WSLPG:', err.message);
    res.status(502).json({ ok: false, error: err.message, timestamp: new Date().toISOString() });
  }
});

// No devuelve certificado, clave, token ni firma: sÃ³lo metadatos verificables.
router.get('/diagnostico/autorizaciones', async (req, res) => {
  try {
    const resultado = await arcaOfficialClient.diagnosticarAutorizaciones();
    res.json({ ok: true, resultado, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('DiagnÃ³stico de autorizaciones ARCA:', err.message);
    res.status(502).json({ ok: false, error: err.message, timestamp: new Date().toISOString() });
  }
});

router.post('/sync/facturas-emitidas', async (req, res) => {
  try {
    const job = await arcaOfficialClient.iniciarSyncFacturasEmitidas({
      desde: req.body?.desde || '2026-01-01',
      limite: req.body?.limite || 1000,
      userId: req.user?.id || null
    });
    res.status(202).json({ ok: true, job, soloConsulta: true });
  } catch (err) {
    res.status(422).json({ ok: false, error: err.message });
  }
});

// Importa Ãºnicamente documentos ya emitidos en ARCA. Incluye LPG, LSG,
// ajustes contenidos en ellas y certificaciones electrÃ³nicas de granos.
router.post('/sync/granos', async (req, res) => {
  try {
    const job = await arcaOfficialClient.iniciarSyncWslpg({
      desde: req.body?.desde || '2026-01-01',
      limite: req.body?.limite || 2000,
      puntosEmision: req.body?.puntosEmision || [1],
      userId: req.user?.id || null
    });
    res.status(202).json({ ok: true, job, soloConsulta: true });
  } catch (err) {
    res.status(422).json({ ok: false, error: err.message });
  }
});

// Consulta documentos ya emitidos por su COE y conserva el PDF oficial cuando
// ARCA lo incluye. No autoriza, ajusta ni anula liquidaciones.
router.post('/sync/granos-por-coe', async (req, res) => {
  try {
    const resultado = await arcaOfficialClient.importarWslpgPorCoe(req.body?.coes || []);
    res.json({ ok: true, resultado, soloConsulta: true });
  } catch (err) {
    res.status(422).json({ ok: false, error: err.message });
  }
});

router.get('/sync/resumen/documentos', async (req, res) => {
  try {
    const fuentes = await arcaOfficialClient.obtenerResumenDocumentos();
    res.json({ ok: true, fuentes, soloConsulta: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/documentos', async (req, res) => {
  try {
    const resultado = await arcaOfficialClient.listarDocumentosOficiales({
      fuente: req.query.fuente || 'WSFE_EMITIDA',
      desde: req.query.desde || null,
      hasta: req.query.hasta || null,
      buscar: req.query.buscar || '',
      pagina: req.query.pagina || 1,
      limite: req.query.limite || 50
    });
    res.json({ ok: true, ...resultado, soloConsulta: true });
  } catch (err) {
    res.status(422).json({ ok: false, error: err.message });
  }
});

router.get('/documentos/conciliacion-contrapartes', async (req, res) => {
  try {
    const resultado = await arcaOfficialClient.resumirConciliacionContrapartes();
    res.json({ ok: true, ...resultado, soloConsulta: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Borrador fiscal de solo lectura. No presenta IVA ni genera asientos.
router.get('/documentos/iva-ventas/resumen', async (req, res) => {
  try {
    const resultado = await arcaOfficialClient.resumirIvaVentas({
      desde: req.query.desde || null,
      hasta: req.query.hasta || null
    });
    res.json({ ok: true, resultado, soloConsulta: true, requiereRevisionHumana: true });
  } catch (err) {
    res.status(422).json({ ok: false, error: err.message });
  }
});

router.get('/sync/:id', async (req, res) => {
  try {
    const job = await arcaOfficialClient.obtenerSyncJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'SincronizaciÃ³n no encontrada.' });
    res.json({ ok: true, job });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/diagnostico/credenciales', (req, res) => {
  try {
    const resultado = arcaOfficialClient.diagnosticarCredenciales();
    res.json({ ok: true, resultado, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('DiagnÃ³stico de credenciales ARCA:', err.message);
    res.status(422).json({ ok: false, error: err.message, timestamp: new Date().toISOString() });
  }
});

// 2. GET Listado de Cartas de Porte en trÃ¡nsito
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

// 3. GET Datos extendidos de PadrÃ³n A13 por CUIT
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

// 5. POST Procesar LiquidaciÃ³n Primaria de Granos (WSLPG)
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

// 7. POST Emitir Factura ElectrÃ³nica
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
      return res.status(400).json({ error: 'ParÃ¡metros obligatorios faltantes: tipo, puntoVenta, numero' });
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
