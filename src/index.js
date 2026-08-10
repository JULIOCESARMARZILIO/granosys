require('dotenv').config();
const express = require('express');
const path = require('path');
const { initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Frontend y API se sirven desde el mismo origen (este mismo Express),
// asi que no hace falta CORS abierto para el uso normal de la app.
app.use(express.json({ limit: '8mb' }));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.0.0', time: new Date() }));

// Autenticación - protege todo /api salvo /api/usuarios/login
app.use('/api', require('./middleware/requireAuth'));

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
