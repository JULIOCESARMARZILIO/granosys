require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { initDB, pool } = require('./db');
const arcaOfficialClient = require('./services/arcaOfficialClient');
const arcaCertificateExtractor = require('./services/arcaCertificateExtractor');

const app = express();
const PORT = process.env.PORT || 3000;

// Frontend y API se sirven desde el mismo origen (este mismo Express),
// asi que no hace falta CORS abierto para el uso normal de la app.
app.use(express.json({ limit: '8mb' }));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.0.0', time: new Date() }));


function tokenImportacionValido(req) {
  const esperado = Buffer.from(String(process.env.ARCA_INTERACTIVE_IMPORT_TOKEN || ''));
  const recibido = Buffer.from(String(req.get('x-import-token') || req.query.token || ''));
  return esperado.length > 20 &&
    esperado.length === recibido.length &&
    crypto.timingSafeEqual(esperado, recibido);
}

app.get('/internal/arca/certificados', (req, res) => {
  if (!tokenImportacionValido(req)) return res.status(404).end();
  res.type('html').send(`<!doctype html><meta charset="utf-8">
  <title>Importar certificados ARCA</title>
  <h1>Importar certificados oficiales ARCA</h1>
  <p>Solo consulta. Los archivos se guardan por COE y no crean CTG.</p>
  <label>Manifiesto JSON <input id="manifest" type="file" accept=".json"></label><br><br>
  <label>PDF por COE <input id="pdfs" type="file" accept=".pdf" multiple></label><br><br>
  <button id="start">Importar</button>
  <pre id="status"></pre>
  <script>
    const token = new URLSearchParams(location.search).get('token');
    const status = document.getElementById('status');
    const toBase64 = buffer => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    };
    document.getElementById('start').onclick = async () => {
      const manifestFile = document.getElementById('manifest').files[0];
      const files = [...document.getElementById('pdfs').files];
      if (!manifestFile || !files.length) throw new Error('Faltan archivos.');
      const manifest = JSON.parse(await manifestFile.text());
      const byCoe = new Map(manifest.map(item => [String(item.coe), item]));
      let ok = 0;
      const errors = [];
      for (const file of files) {
        const coe = (file.name.match(/\\d{12}/) || [])[0];
        try {
          if (!coe || !byCoe.has(coe)) throw new Error('COE sin manifiesto');
          const response = await fetch('/internal/arca/certificados', {
            method: 'POST',
            headers: {'Content-Type':'application/json','x-import-token':token},
            body: JSON.stringify({
              coe,
              metadata: byCoe.get(coe),
              pdfBase64: toBase64(await file.arrayBuffer())
            })
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || response.status);
          ok += 1;
        } catch (error) {
          errors.push({file:file.name,error:error.message});
        }
        status.textContent = JSON.stringify({procesados:ok+errors.length,ok,errores:errors.length}, null, 2);
      }
      const linkResponse = await fetch('/internal/arca/certificados/vincular', {
        method:'POST',
        headers:{'x-import-token':token}
      });
      const vinculacion = await linkResponse.json();
      status.textContent = JSON.stringify({total:files.length,ok,errors,vinculacion}, null, 2);
    };
  </script>`);
});

app.post('/internal/arca/certificados', async (req, res) => {
  if (!tokenImportacionValido(req)) return res.status(404).end();
  try {
    const pdfBuffer = Buffer.from(String(req.body.pdfBase64 || ''), 'base64');
    const resultado = await arcaOfficialClient.importarCertificadoInteractivo({
      coe: req.body.coe,
      metadata: req.body.metadata || {},
      pdfBuffer
    });
    res.json({ ok: true, resultado });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/internal/arca/certificados/vincular', async (req, res) => {
  if (!tokenImportacionValido(req)) return res.status(404).end();
  try {
    res.json({ ok: true, resultado: await arcaOfficialClient.materializarCertificadosCtg() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Autenticación - protege todo /api salvo /api/usuarios/login
app.use('/api', require('./middleware/requireAuth'));

// Rutas API - VAN ANTES del static
app.use('/api/contrapartes', require('./routes/contrapartes'));
app.use('/api/especies',     require('./routes/especies'));
app.use('/api/campanas',     require('./routes/campanas'));
app.use('/api/contratos',    require('./routes/contratos'));
app.use('/api/movimientos',  require('./routes/movimientos'));
app.use('/api/derivados',    require('./routes/derivados'));
app.use('/api/liquidaciones',require('./routes/liquidaciones'));
app.use('/api/cc',           require('./routes/cuentacorriente'));
app.use('/api/tesoreria',    require('./routes/tesoreria'));
app.use('/api/stock',        require('./routes/stock'));
app.use('/api/reportes',     require('./routes/reportes'));
app.use('/api/arca',         require('./routes/arca'));
app.use('/api/usuarios',     require('./routes/usuarios'));
app.use('/api/agent',        require('./routes/agent'));
app.use('/api/whatsapp',     require('./routes/whatsapp'));
app.use('/api/ubicaciones',  require('./routes/ubicaciones'));
app.use('/api/auditoria',    require('./routes/auditoria'));
app.use('/api/precios',      require('./routes/precios'));
app.use('/api/posicion',     require('./routes/posicion'));
app.use('/api/kpis',         require('./routes/kpis'));
app.use('/api/regularizacion', require('./routes/regularizacion'));
app.use('/api/retiros-productor', require('./routes/retiros'));
app.use('/api/certificados-1116', require('./routes/certificados1116'));
app.use('/api/reportes-descarga', require('./routes/reportesDescarga'));

// Frontend - VA AL FINAL
app.get('/mobile', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/mobile.html'));
});
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

function iniciarBackfillCertificadosDeposito() {
  const coes = [...new Set(String(process.env.ARCA_CERTIFICADOS_COE_BACKFILL || '')
    .split(',')
    .map(value => value.replace(/\D/g, ''))
    .filter(value => /^\d{12}$/.test(value)))];
  if (!coes.length) return;

  setImmediate(async () => {
    try {
      const job = await arcaOfficialClient.iniciarSyncWslpgPdfPorCoe({
        coes,
        desde: '2026-02-01'
      });
      console.log('Backfill certificados de deposito iniciado:', {
        jobId: job.id,
        totalCoes: coes.length
      });

      for (let intento = 0; intento < 360; intento += 1) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        const estado = await arcaOfficialClient.obtenerSyncJob(job.id);
        if (estado && ['COMPLETADO', 'PARCIAL', 'ERROR'].includes(estado.estado)) {
          console.log('Backfill certificados de deposito finalizado:', {
            jobId: job.id,
            estado: estado.estado,
            revisados: estado.total_revisados,
            importadosConPdf: estado.total_importados,
            error: estado.error || null
          });
          return;
        }
      }
      console.error('Backfill certificados de deposito pendiente: tiempo de espera agotado', {
        jobId: job.id
      });
    } catch (error) {
      console.error('Backfill certificados de deposito no iniciado:', error.message);
    }
  });
}

function iniciarBackfillCpeConfirmadas() {
  const configuracion = String(process.env.ARCA_CPE_CONFIRMADAS_BACKFILL || '').trim();
  if (!configuracion) return;
  const [desde, hasta] = configuracion.split(':');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(hasta || '')) {
    console.error('Backfill CPE/CPEDG confirmadas no iniciado: use AAAA-MM-DD:AAAA-MM-DD');
    return;
  }

  setImmediate(async () => {
    try {
      const job = await arcaOfficialClient.iniciarSyncCpeDestino({
        desde,
        hasta,
        soloConfirmadas: true
      });
      console.log('Backfill CPE/CPEDG confirmadas iniciado:', { jobId: job.id, desde, hasta });

      for (let intento = 0; intento < 2160; intento += 1) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        const estado = await arcaOfficialClient.obtenerSyncJob(job.id);
        if (!estado || !['COMPLETADO', 'PARCIAL', 'ERROR'].includes(estado.estado)) continue;
        console.log('Backfill CPE/CPEDG confirmadas finalizado:', {
          jobId: job.id,
          estado: estado.estado,
          revisados: estado.total_revisados,
          importados: estado.total_importados,
          detalle: estado.error || null
        });
        if (estado.total_importados > 0) {
          const movimientos = await arcaOfficialClient.materializarMovimientosCpe({
            desde,
            soloConfirmadas: true
          });
          const certificados = await arcaOfficialClient.materializarCertificadosCtg();
          const extraccionCertificados = await arcaCertificateExtractor.extractAllCertificates({ limit: 10000 });
          const calidades = await arcaCertificateExtractor.assignExistingCpesAndQualities();
          console.log('CPE/CPEDG confirmadas materializadas:', {
            movimientos,
            certificados,
            extraccionCertificados,
            calidades
          });
        }
        return;
      }
      console.error('Backfill CPE/CPEDG confirmadas pendiente: tiempo de espera agotado', { jobId: job.id });
    } catch (error) {
      console.error('Backfill CPE/CPEDG confirmadas no iniciado:', error.message);
    }
  });
}

async function diagnosticarCpeEmitidasElSieteDeJulio() {
  const fecha = '2026-07-07';
  const [documentos, trabajos] = await Promise.all([
    pool.query(`
      SELECT d.external_key AS ctg, d.document_date, r.tipo_cpe,
             (regexp_match(COALESCE(d.payload->>'rawXml',''), '<(?:\\w+:)?estado[^>]*>([^<]+)'))[1] AS estado_arca,
             EXISTS(SELECT 1 FROM arca_cpe_movement_links l WHERE l.document_id=d.id) AS tiene_movimiento,
             COALESCE((SELECT jsonb_agg(DISTINCT p.rol ORDER BY p.rol)
                       FROM arca_cpe_participants p WHERE p.document_id=d.id), '[]'::jsonb) AS roles,
             d.first_imported_at, d.last_seen_at
      FROM arca_official_documents d
      LEFT JOIN arca_cpe_registry r ON r.document_id=d.id
      WHERE d.fuente='WSCPE_CPE'
        AND (d.document_date=$1::date
          OR d.payload::text ILIKE '%2026-07-07%'
          OR d.payload::text ILIKE '%07/07/2026%')
      ORDER BY d.document_date, d.external_key
    `, [fecha]),
    pool.query(`
      SELECT id, fuente, desde, estado, total_revisados, total_importados,
             error, created_at, started_at, finished_at
      FROM arca_sync_jobs
      WHERE fuente IN ('WSCPE_DESTINO','WSCPE_CPE')
      ORDER BY created_at DESC
      LIMIT 20
    `)
  ]);
  console.log('DIAGNOSTICO_CPE_2026_07_07=' + JSON.stringify({
    fecha,
    documentos: documentos.rows,
    trabajos: trabajos.rows
  }));
}

async function start() {
  try {
    await initDB();
    await diagnosticarCpeEmitidasElSieteDeJulio().catch(error =>
      console.error('DIAGNOSTICO_CPE_2026_07_07_ERROR=' + error.message));
    app.listen(PORT, () => console.log(`GranoSYS v2.0 corriendo en puerto ${PORT}`));
    iniciarBackfillCertificadosDeposito();
    iniciarBackfillCpeConfirmadas();
    if (String(process.env.ARCA_DIAGNOSTICO_DERIVADOS || '').toLowerCase() === 'true') {
      setImmediate(() => arcaOfficialClient.diagnosticarDerivadosPendientes()
        .then(resultado => console.log('DIAGNOSTICO_DERIVADOS_CPEDG=' + JSON.stringify(resultado)))
        .catch(error => console.error('Diagnóstico CPEDG pendiente:', error.message)));
    }
    if (String(process.env.ARCA_REFRESH_DERIVADOS_PENDIENTES || '').toLowerCase() === 'true') {
      setImmediate(async () => {
        try {
          const job = await arcaOfficialClient.iniciarRefreshDerivadosPendientes();
          if (!job) return console.log('Refresh CPEDG: no hay pendientes.');
          console.log('Refresh CPEDG iniciado:', { jobId: job.id, total: job.totalCtgs });
          for (let intento=0; intento<720; intento+=1) {
            await new Promise(resolve=>setTimeout(resolve,10000));
            const estado=await arcaOfficialClient.obtenerSyncJob(job.id);
            if (!estado || !['COMPLETADO','PARCIAL','ERROR'].includes(estado.estado)) continue;
            console.log('Refresh CPEDG finalizado:', { estado:estado.estado,revisados:estado.total_revisados,importados:estado.total_importados,error:estado.error||null });
            console.log('DIAGNOSTICO_DERIVADOS_ARCA=' + JSON.stringify(await arcaOfficialClient.diagnosticarDerivadosPendientes()));
            return;
          }
        } catch (error) { console.error('Refresh CPEDG pendiente:', error.message); }
      });
    }
    setImmediate(() => {
      arcaOfficialClient.materializarCertificadosCtg()
        .then(resultado => console.log('Vinculacion certificados a CTG existentes completada:', resultado))
        .catch(error => console.error('Vinculacion certificados a CTG pendiente:', error.message));
    });
    setImmediate(() => {
      arcaOfficialClient.materializarMovimientosCpe({ desde: '2026-02-01', soloConfirmadas: true })
        .then(resultado => console.log('Backfill CPE/CPEDG a Movimientos completado:', resultado))
        .catch(error => console.error('Backfill CPE/CPEDG a Movimientos pendiente:', error.message));
    });
  } catch (err) {
    console.error('Error al iniciar:', err);
    process.exit(1);
  }
}

start();
