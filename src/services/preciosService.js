const { pool } = require('../db');

// Devuelve el precio vigente de una especie/subproducto a una fecha dada.
// Prioriza precios especificos de ubicacion/modalidad por sobre los generales;
// entre varios aplicables, el mas reciente. Devuelve null si nunca se cargo.
async function precioVigente(id_especie, fecha, { id_ubicacion, modalidad } = {}) {
  const { rows } = await pool.query(`
    SELECT id, precio, moneda, vigente_desde, usuario
    FROM precios_referencia
    WHERE id_especie = $1
      AND vigente_desde <= $2
      AND (id_ubicacion = $3 OR id_ubicacion IS NULL)
      AND (modalidad = $4 OR modalidad IS NULL)
    ORDER BY (id_ubicacion IS NOT NULL) DESC, (modalidad IS NOT NULL) DESC, vigente_desde DESC
    LIMIT 1
  `, [id_especie, fecha, id_ubicacion || null, modalidad || null]);
  return rows[0] || null;
}

module.exports = { precioVigente };
