require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS abierto
app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors());
app.use(express.json());

// Health check PRIMERO
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// Rutas API ANTES del static
app.use('/api/contrapartes', require('./routes/contrapartes'));
app.use('/api/especies', require('./routes/especies'));
app.use('/api/campanas', require('./routes/campanas'));
app.use('/api/contratos', require('./routes/contratos'));
app.use('/api/movimientos', require('./routes/movimientos'));
app.use('/api/liquidaciones', require('./routes/liquidaciones'));
app.use('/api/cc', require('./routes/cuentacorriente'));
app.use('/api/stock', require('./routes/stock'));
app.use('/api/reportes', require('./routes/reportes'));

// Static y frontend AL FINAL
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

async function start() {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`GranoSYS corriendo en puerto ${PORT}`);
    });
  } catch (err) {
    console.error('Error al iniciar:', err);
    process.exit(1);
  }
}

start();
