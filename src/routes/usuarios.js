const router = require('express').Router();
const { pool } = require('../db');
const crypto = require('crypto');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// POST /login - Autenticar usuario
router.post('/login', async (req, res) => {
  try {
    const { usuario, contrasena } = req.body;
    if (!usuario || !contrasena) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }

    const hash = hashPassword(contrasena);

    const { rows } = await pool.query(
      'SELECT id, usuario, nombre, rol, activo, ver_informal FROM usuarios WHERE usuario = $1 AND contrasena = $2',
      [usuario, hash]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    const user = rows[0];
    if (!user.activo) {
      return res.status(403).json({ error: 'El usuario está inactivo' });
    }

    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET / - Listar todos los usuarios
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, usuario, nombre, rol, activo, ver_informal, created_at FROM usuarios ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST / - Crear usuario nuevo
router.post('/', async (req, res) => {
  try {
    const { usuario, contrasena, nombre, rol, ver_informal } = req.body;
    if (!usuario || !contrasena || !nombre || !rol) {
      return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }

    const hash = hashPassword(contrasena);

    const { rows } = await pool.query(`
      INSERT INTO usuarios (usuario, contrasena, nombre, rol, activo, ver_informal)
      VALUES ($1, $2, $3, $4, TRUE, $5) RETURNING id, usuario, nombre, rol, activo, ver_informal
    `, [usuario, hash, nombre, rol, ver_informal || false]);

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'El nombre de usuario ya existe' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /:id - Modificar usuario
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { usuario, contrasena, nombre, rol, activo, ver_informal } = req.body;

    if (!usuario || !nombre || !rol) {
      return res.status(400).json({ error: 'Usuario, Nombre y Rol son requeridos' });
    }

    let query = 'UPDATE usuarios SET usuario=$1, nombre=$2, rol=$3, activo=$4, ver_informal=$5';
    const params = [usuario, nombre, rol, activo, ver_informal !== undefined ? ver_informal : false];

    if (contrasena && contrasena.trim() !== '') {
      const hash = hashPassword(contrasena);
      params.push(hash);
      query += `, contrasena=$${params.length}`;
    }

    params.push(id);
    query += ` WHERE id=$${params.length} RETURNING id, usuario, nombre, rol, activo, ver_informal`;

    const { rows } = await pool.query(query, params);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'El nombre de usuario ya existe' });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /:id - Eliminar usuario
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Evitar auto-eliminación si es el usuario actual, eso se valida en el frontend,
    // pero evitamos eliminar el admin principal
    const { rows: user } = await pool.query('SELECT usuario FROM usuarios WHERE id = $1', [id]);
    if (user[0] && user[0].usuario === 'admin') {
      return res.status(400).json({ error: 'No se puede eliminar el usuario administrador principal' });
    }

    const { rowCount } = await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
