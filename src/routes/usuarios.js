const router = require('express').Router();
const { pool } = require('../db');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { registrarAuditoria } = require('../services/auditoria');

function hashPasswordLegacy(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function esHashBcrypt(hash) {
  return typeof hash === 'string' && /^\$2[aby]\$/.test(hash);
}

function firmarToken(user) {
  return jwt.sign(
    { id: user.id, usuario: user.usuario, rol: user.rol },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function requiereAdmin(req, res) {
  if (!req.user || req.user.rol !== 'ADMIN') {
    res.status(403).json({ error: 'Requiere rol ADMIN' });
    return false;
  }
  return true;
}

// POST /login - Autenticar usuario
router.post('/login', async (req, res) => {
  try {
    const { usuario, contrasena } = req.body;
    if (!usuario || !contrasena) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }

    const { rows } = await pool.query(
      'SELECT id, usuario, nombre, rol, activo, contrasena FROM usuarios WHERE usuario = $1',
      [usuario]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    const user = rows[0];
    let coincide = false;

    if (esHashBcrypt(user.contrasena)) {
      coincide = bcrypt.compareSync(contrasena, user.contrasena);
    } else if (user.contrasena === hashPasswordLegacy(contrasena)) {
      coincide = true;
      // Migración silenciosa a bcrypt en el primer login exitoso con el hash viejo.
      const nuevoHash = hashPassword(contrasena);
      await pool.query('UPDATE usuarios SET contrasena=$1 WHERE id=$2', [nuevoHash, user.id]);
    }

    if (!coincide) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    if (!user.activo) {
      return res.status(403).json({ error: 'El usuario está inactivo' });
    }

    const userSinHash = { id: user.id, usuario: user.usuario, nombre: user.nombre, rol: user.rol, activo: user.activo };
    res.json({ token: firmarToken(userSinHash), user: userSinHash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET / - Listar todos los usuarios
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, usuario, nombre, rol, activo, created_at FROM usuarios ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST / - Crear usuario nuevo
router.post('/', async (req, res) => {
  try {
    if (!requiereAdmin(req, res)) return;
    const { usuario, contrasena, nombre, rol } = req.body;
    if (!usuario || !contrasena || !nombre || !rol) {
      return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }

    const hash = hashPassword(contrasena);

    const { rows } = await pool.query(`
      INSERT INTO usuarios (usuario, contrasena, nombre, rol, activo)
      VALUES ($1, $2, $3, $4, TRUE) RETURNING id, usuario, nombre, rol, activo
    `, [usuario, hash, nombre, rol]);

    await registrarAuditoria(req, {
      accion: 'CREAR', modulo: 'usuarios', registro_id: rows[0].id,
      datos_despues: rows[0]
    });

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
    if (!requiereAdmin(req, res)) return;
    const { id } = req.params;
    const { usuario, contrasena, nombre, rol, activo } = req.body;

    if (!usuario || !nombre || !rol) {
      return res.status(400).json({ error: 'Usuario, Nombre y Rol son requeridos' });
    }

    const { rows: antesRows } = await pool.query(
      'SELECT id, usuario, nombre, rol, activo FROM usuarios WHERE id=$1', [id]
    );

    let query = 'UPDATE usuarios SET usuario=$1, nombre=$2, rol=$3, activo=$4';
    const params = [usuario, nombre, rol, activo];
    let cambioContrasena = false;

    if (contrasena && contrasena.trim() !== '') {
      const hash = hashPassword(contrasena);
      params.push(hash);
      query += `, contrasena=$${params.length}`;
      cambioContrasena = true;
    }

    params.push(id);
    query += ` WHERE id=$${params.length} RETURNING id, usuario, nombre, rol, activo`;

    const { rows } = await pool.query(query, params);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    await registrarAuditoria(req, {
      accion: 'MODIFICAR', modulo: 'usuarios', registro_id: rows[0].id,
      datos_antes: antesRows[0] || null,
      datos_despues: { ...rows[0], contrasena_modificada: cambioContrasena }
    });

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
    if (!requiereAdmin(req, res)) return;
    const { id } = req.params;

    // Evitar auto-eliminación si es el usuario actual, eso se valida en el frontend,
    // pero evitamos eliminar el admin principal
    const { rows: user } = await pool.query('SELECT id, usuario, nombre, rol, activo FROM usuarios WHERE id = $1', [id]);
    if (user[0] && user[0].usuario === 'admin') {
      return res.status(400).json({ error: 'No se puede eliminar el usuario administrador principal' });
    }

    const { rowCount } = await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    await registrarAuditoria(req, {
      accion: 'ELIMINAR', modulo: 'usuarios', registro_id: parseInt(id),
      datos_antes: user[0] || null
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
