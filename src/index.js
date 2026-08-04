require('dotenv').config();
const express = require('express');
const path = require('path');
const { initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Frontend y API se sirven desde el mismo origen (este mismo Express),
// asi que no hace falta CORS abierto para el uso normal de la app.
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
