const router = require('express').Router();
const { pool } = require('../db');

// GET /api/regularizacion/por-productor
// Compara, por productor, cuanto entrego informal vs. cuanto formalizo
// despues como produccion propia (CTG 101), sin exigir que coincidan
// camion a camion -- es para ver de un vistazo si cierra la cuenta,
// no un vinculo estricto entre movimientos puntuales.
router.get('/por-productor', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(m.remitente_comercial_productor_cuit, m.titular_cpe_cuit) as cuit,
        COALESCE(m.remitente_comercial_productor_nombre, m.titular_cpe_nombre) as nombre,
        m.modalidad, m.origen_produccion, m.id_especie, e.nombre as especie_nombre,
        m.kg_liquidables, m.peso_neto_salida_kg, m.id_contrato_compra
      FROM movimientos m
      LEFT JOIN especies e ON m.id_especie = e.id
      WHERE COALESCE(m.remitente_comercial_productor_cuit, m.titular_cpe_cuit) IS NOT NULL
    `);

    const porProductor = new Map();
    for (const m of rows) {
      const clave = `${m.cuit}|${m.id_especie}`;
      if (!porProductor.has(clave)) {
        porProductor.set(clave, {
          productor: m.nombre, cuit: m.cuit, especie_nombre: m.especie_nombre,
          tn_informal_total: 0, tn_informal_sin_contrato: 0,
          tn_formal_propia: 0
        });
      }
      const g = porProductor.get(clave);
      const kg = parseFloat(m.kg_liquidables || m.peso_neto_salida_kg || 0);
      const tn = kg / 1000;

      if (m.modalidad === 'INFORMAL') {
        g.tn_informal_total += tn;
        if (!m.id_contrato_compra) g.tn_informal_sin_contrato += tn;
      } else if (m.modalidad === 'FORMAL' && m.origen_produccion === 'PROPIA') {
        g.tn_formal_propia += tn;
      }
    }

    const resultado = Array.from(porProductor.values())
      .filter(g => g.tn_informal_total > 0 || g.tn_formal_propia > 0)
      .map(g => ({
        productor: g.productor,
        cuit: g.cuit,
        especie_nombre: g.especie_nombre,
        tn_informal_total: Math.round(g.tn_informal_total * 1000) / 1000,
        tn_informal_sin_contrato: Math.round(g.tn_informal_sin_contrato * 1000) / 1000,
        tn_formal_propia: Math.round(g.tn_formal_propia * 1000) / 1000,
        diferencia: Math.round((g.tn_informal_total - g.tn_formal_propia) * 1000) / 1000
      }))
      .sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));

    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
