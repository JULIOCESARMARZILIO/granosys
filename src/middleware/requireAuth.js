const jwt = require('jsonwebtoken');

// Rutas bajo /api que no requieren estar logueado.
const RUTAS_PUBLICAS = ['/usuarios/login'];

function requireAuth(req, res, next) {
  if (RUTAS_PUBLICAS.includes(req.path)) return next();

  const header = req.get('Authorization') || '';
  const [tipo, token] = header.split(' ');
  if (tipo !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o vencido' });
  }
}

module.exports = requireAuth;
