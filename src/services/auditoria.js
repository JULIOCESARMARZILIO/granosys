const { pool } = require('../db');

// Registra un evento en la auditoria inmutable. Nunca lanza: un fallo al
// auditar no debe impedir que la operacion de negocio se complete.
async function registrarAuditoria(req, { accion, modulo, registro_id, datos_antes, datos_despues }) {
  const usuario = (req && req.user && req.user.usuario) || (req && req.get && req.get('X-Usuario-Actual')) || 'desconocido';
  const ip = req ? (req.ip || null) : null;
  try {
    await pool.query(
      `INSERT INTO auditoria (usuario, accion, modulo, registro_id, datos_antes, datos_despues, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        usuario,
        accion,
        modulo,
        registro_id || null,
        datos_antes !== undefined && datos_antes !== null ? JSON.stringify(datos_antes) : null,
        datos_despues !== undefined && datos_despues !== null ? JSON.stringify(datos_despues) : null,
        ip
      ]
    );
  } catch (err) {
    console.error('Error registrando auditoria:', err.message);
  }
}

module.exports = { registrarAuditoria };
