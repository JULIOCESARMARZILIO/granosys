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

// Frontend - VA AL FINAL
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
