require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS abierto para cualquier origen
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.0.0', time: new Date() }));

// Rutas API - VAN ANTES del static
app.use('/api/contrapartes', require('./routes/contrapartes'));
app.use('/api/especies',     require('./routes/especies'));
app.use('/api/campanas',     require('./routes/campanas'));
app.use('/api/contratos',    require('./routes/contratos'));
app.use('/api/movimientos',  require('./routes/movimientos'));
app.use('/api/liquidaciones',require('./routes/liquidaciones'));
app.use('/api/cc',           require('./routes/cuentacorriente'));
app.use('/api/stock',        require('./routes/stock'));
app.use('/api/reportes',     require('./routes/reportes'));
app.use('/api/arca',         require('./routes/arca'));
app.use('/api/usuarios',     require('./routes/usuarios'));
app.use('/api/agent',        require('./routes/agent'));
app.use('/api/whatsapp',     require('./routes/whatsapp'));
app.use('/api/ubicaciones',  require('./routes/ubicaciones'));

// Endpoint de diagnóstico temporal para ver archivos y commits en Railway
app.get('/api/debug-files', (req, res) => {
  const fs = require('fs');
  const { execSync } = require('child_process');
  
  const debugData = {};
  
  // 1. Contenido de directorios
  try {
    debugData.files = fs.readdirSync(path.join(__dirname, '..'));
    debugData.publicFiles = fs.readdirSync(path.join(__dirname, '../public'));
  } catch (err) {
    debugData.filesError = err.message;
  }
  
  // 2. Versión en el archivo index.html en disco
  try {
    const indexPath = path.join(__dirname, '../public/index.html');
    const indexContent = fs.readFileSync(indexPath, 'utf8');
    const versionMatch = indexContent.match(/v2\.1\.\d+/);
    debugData.indexHtmlVersion = versionMatch ? versionMatch[0] : "Not found";
  } catch (err) {
    debugData.indexHtmlVersionError = err.message;
  }
  
  // 3. Ejecución de comandos Git (si están disponibles)
  try {
    debugData.gitLog = execSync('git log -n 5 --oneline', { encoding: 'utf8' }).split('\n');
    debugData.gitStatus = execSync('git status', { encoding: 'utf8' }).split('\n');
  } catch (err) {
    debugData.gitError = err.message;
  }
  
  // 4. Variables de entorno de Railway
  debugData.env = {
    PORT: process.env.PORT,
    NODE_ENV: process.env.NODE_ENV,
    RAILWAY_STATIC_URL: process.env.RAILWAY_STATIC_URL,
    RAILWAY_GIT_COMMIT_SHA: process.env.RAILWAY_GIT_COMMIT_SHA,
    RAILWAY_GIT_COMMIT_MESSAGE: process.env.RAILWAY_GIT_COMMIT_MESSAGE,
    RAILWAY_GIT_BRANCH: process.env.RAILWAY_GIT_BRANCH
  };

  res.json(debugData);
});

// Frontend - VA AL FINAL
app.get('/mobile', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/mobile.html'));
});
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

async function start() {
  try {
    await initDB();
    app.listen(PORT, () => console.log(`GranoSYS v2.0 corriendo en puerto ${PORT}`));
  } catch (err) {
    console.error('Error al iniciar:', err);
    process.exit(1);
  }
}

start();
