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

// Busca el valor de flete ($/tn) para una distancia dada en la tabla de
// fletes marcada como default. Toma la tarifa del km cargado mas cercano
// (por debajo o igual) a la distancia pedida; si no hay ninguna <=, usa la
// mas barata disponible.
async function fleteParaKm(km) {
  if (km === null || km === undefined) return null;
  const { rows: tablas } = await pool.query('SELECT id FROM tablas_flete WHERE es_default = true AND activa = true LIMIT 1');
  const idTabla = tablas[0]?.id;
  if (!idTabla) return null;

  const { rows } = await pool.query(
    `SELECT valor_tonelada FROM tarifas_flete WHERE id_tabla = $1 AND km <= $2 ORDER BY km DESC LIMIT 1`,
    [idTabla, km]
  );
  if (rows[0]) return parseFloat(rows[0].valor_tonelada);

  const { rows: minRows } = await pool.query(
    `SELECT valor_tonelada FROM tarifas_flete WHERE id_tabla = $1 ORDER BY km ASC LIMIT 1`,
    [idTabla]
  );
  return minRows[0] ? parseFloat(minRows[0].valor_tonelada) : null;
}

// Precio neto de una especie en una ubicacion puntual, a una fecha dada:
// 1. Si hay un precio de referencia cargado a mano especifico para esa
//    ubicacion, ese gana siempre.
// 2. Si no, toma el precio de referencia general y le resta el flete
//    estimado desde esa ubicacion (segun su km_a_referencia y la tabla de
//    fletes default), si la ubicacion tiene esa distancia cargada.
// Devuelve { precio, moneda, ajustadoPorFlete, tieneReferencia }.
async function precioNetoUbicacion(id_especie, id_ubicacion, fecha) {
  if (id_ubicacion) {
    const especifico = await precioVigente(id_especie, fecha, { id_ubicacion });
    if (especifico && especifico.id) {
      const { rows } = await pool.query('SELECT id_ubicacion FROM precios_referencia WHERE id = $1', [especifico.id]);
      if (rows[0] && rows[0].id_ubicacion === id_ubicacion) {
        return { precio: parseFloat(especifico.precio), moneda: especifico.moneda, ajustadoPorFlete: false, tieneReferencia: true, manual: true };
      }
    }
  }

  const general = await precioVigente(id_especie, fecha);
  if (!general) return { precio: null, moneda: null, ajustadoPorFlete: false, tieneReferencia: false, manual: false };

  if (!id_ubicacion) {
    return { precio: parseFloat(general.precio), moneda: general.moneda, ajustadoPorFlete: false, tieneReferencia: true, manual: false };
  }

  const { rows: ubicRows } = await pool.query('SELECT km_a_referencia FROM ubicaciones WHERE id = $1', [id_ubicacion]);
  const km = ubicRows[0]?.km_a_referencia !== null && ubicRows[0]?.km_a_referencia !== undefined
    ? parseFloat(ubicRows[0].km_a_referencia) : null;

  if (km === null) {
    return { precio: parseFloat(general.precio), moneda: general.moneda, ajustadoPorFlete: false, tieneReferencia: true, manual: false };
  }

  const flete = await fleteParaKm(km);
  const precioNeto = flete !== null ? parseFloat(general.precio) - flete : parseFloat(general.precio);
  return { precio: precioNeto, moneda: general.moneda, ajustadoPorFlete: flete !== null, tieneReferencia: true, manual: false };
}

module.exports = { precioVigente, precioNetoUbicacion };
