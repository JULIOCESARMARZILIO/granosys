const router = require('express').Router();
const crypto = require('crypto');
const { pool } = require('../db');

const MODALIDADES = new Set(['FORMAL', 'INFORMAL']);
const TIPOS = new Set(['COMPRA', 'VENTA']);

async function siguienteNumero(client) {
  const { rows } = await client.query(`
    SELECT COALESCE(MAX((regexp_match(numero_operacion, '^DER-([0-9]+)$'))[1]::bigint),0) ultimo
    FROM derivados_operaciones WHERE numero_operacion ~ '^DER-[0-9]+$'
  `);
  return `DER-${String(Number(rows[0]?.ultimo || 0) + 1).padStart(6, '0')}`;
}

router.get('/', async (req, res) => {
  try {
    const params = [];
    let where = 'WHERE 1=1';
    for (const [campo, valor] of [['modalidad', req.query.modalidad], ['tipo_operacion', req.query.tipo]]) {
      if (!valor) continue;
      params.push(String(valor).toUpperCase());
      where += ` AND d.${campo}=$${params.length}`;
    }
    if (req.query.buscar) {
      params.push(`%${String(req.query.buscar).trim()}%`);
      where += ` AND (d.numero_operacion ILIKE $${params.length} OR d.ctg ILIKE $${params.length} OR e.nombre ILIKE $${params.length} OR cp.razon_social ILIKE $${params.length})`;
    }
    const { rows } = await pool.query(`
      SELECT d.*,e.nombre producto_nombre,e.id_especie_origen,cp.razon_social contraparte_nombre,
             c.numero_contrato,es.numero_operacion espejo_numero
      FROM derivados_operaciones d
      JOIN especies e ON e.id=d.id_especie
      LEFT JOIN contrapartes cp ON cp.id=d.id_contraparte
      LEFT JOIN contratos c ON c.id=d.id_contrato
      LEFT JOIN derivados_operaciones es ON es.id=d.id_operacion_espejo
      ${where} ORDER BY d.fecha DESC,d.id DESC LIMIT 500
    `, params);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/buscar-espejo', async (req, res) => {
  try {
    const modalidad = String(req.query.modalidad || '').toUpperCase();
    const opuesta = modalidad === 'FORMAL' ? 'INFORMAL' : 'FORMAL';
    const buscar = `%${String(req.query.buscar || '').trim()}%`;
    const { rows } = await pool.query(`
      SELECT d.id,d.numero_operacion,d.modalidad,d.tipo_operacion,d.fecha,d.kilos,d.ctg,
             e.nombre producto_nombre,cp.razon_social contraparte_nombre
      FROM derivados_operaciones d JOIN especies e ON e.id=d.id_especie
      LEFT JOIN contrapartes cp ON cp.id=d.id_contraparte
      WHERE d.modalidad=$1 AND d.id_operacion_espejo IS NULL
        AND ($2='%%' OR d.numero_operacion ILIKE $2 OR COALESCE(d.ctg,'') ILIKE $2 OR e.nombre ILIKE $2 OR COALESCE(cp.razon_social,'') ILIKE $2)
      ORDER BY d.fecha DESC LIMIT 50
    `, [opuesta, buscar]);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const modalidad = String(req.body.modalidad || '').toUpperCase();
    const tipo = String(req.body.tipo_operacion || '').toUpperCase();
    if (!MODALIDADES.has(modalidad) || !TIPOS.has(tipo)) return res.status(400).json({ error: 'Modalidad o tipo inválido.' });
    if (!req.body.id_especie || !(Number(req.body.kilos) > 0) || !req.body.fecha) return res.status(400).json({ error: 'Producto, fecha y kilos son obligatorios.' });
    await client.query('BEGIN');
    const numero = await siguienteNumero(client);
    const grupo = crypto.randomUUID();
    const { rows } = await client.query(`
      INSERT INTO derivados_operaciones(numero_operacion,grupo_operacion,tipo_operacion,modalidad,fecha,id_especie,id_campana,id_contraparte,id_contrato,kilos,precio,moneda,ctg,cpedg_document_id,factura_compra_document_id,factura_venta_document_id,impacta_stock,observaciones,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,$17,$18) RETURNING *
    `, [numero,grupo,tipo,modalidad,req.body.fecha,req.body.id_especie,req.body.id_campana||null,req.body.id_contraparte||null,req.body.id_contrato||null,req.body.kilos,req.body.precio||null,req.body.moneda||null,req.body.ctg||null,req.body.cpedg_document_id||null,req.body.factura_compra_document_id||null,req.body.factura_venta_document_id||null,req.body.observaciones||null,req.user?.id||null]);
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (error) { await client.query('ROLLBACK'); res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'La CPEDG/CTG ya está cargada en esa modalidad.' : error.message }); }
  finally { client.release(); }
});

router.post('/:id/crear-espejo-formal', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM derivados_operaciones WHERE id=$1 FOR UPDATE', [req.params.id]);
    const origen = rows[0];
    if (!origen) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Operación no encontrada.' }); }
    if (origen.modalidad !== 'INFORMAL') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Solo se crea el espejo formal desde una operación informal.' }); }
    if (origen.id_operacion_espejo) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'La operación ya tiene espejo.' }); }
    const numero = await siguienteNumero(client);
    const { rows: creadas } = await client.query(`
      INSERT INTO derivados_operaciones(numero_operacion,grupo_operacion,tipo_operacion,modalidad,estado,fecha,id_especie,id_campana,id_contraparte,id_contrato,kilos,precio,moneda,ctg,impacta_stock,observaciones,created_by)
      VALUES($1,$2,$3,'FORMAL','BORRADOR',$4,$5,$6,$7,$8,$9,$10,$11,$12,false,$13,$14) RETURNING *
    `, [numero,origen.grupo_operacion,origen.tipo_operacion,origen.fecha,origen.id_especie,origen.id_campana,origen.id_contraparte,origen.id_contrato,origen.kilos,origen.precio,origen.moneda,req.body.ctg||origen.ctg,origen.observaciones,req.user?.id||null]);
    await client.query('UPDATE derivados_operaciones SET id_operacion_espejo=$1 WHERE id=$2', [creadas[0].id,origen.id]);
    await client.query('UPDATE derivados_operaciones SET id_operacion_espejo=$1 WHERE id=$2', [origen.id,creadas[0].id]);
    await client.query('COMMIT');
    res.status(201).json(creadas[0]);
  } catch (error) { await client.query('ROLLBACK'); res.status(500).json({ error: error.message }); }
  finally { client.release(); }
});

router.put('/:id/vincular-espejo', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = [Number(req.params.id), Number(req.body.id_espejo)];
    const { rows } = await client.query('SELECT * FROM derivados_operaciones WHERE id=ANY($1) FOR UPDATE', [ids]);
    if (rows.length !== 2) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No se encontraron ambas operaciones.' }); }
    const [a,b] = ids.map(id => rows.find(row => row.id === id));
    if (a.modalidad === b.modalidad) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'El vínculo debe unir una operación formal con una informal.' }); }
    if (a.tipo_operacion !== b.tipo_operacion || Number(a.id_especie) !== Number(b.id_especie)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Tipo y producto deben coincidir.' }); }
    if (a.id_operacion_espejo || b.id_operacion_espejo) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Una operación ya está vinculada.' }); }
    const grupo = a.grupo_operacion || b.grupo_operacion || crypto.randomUUID();
    const informal = a.modalidad === 'INFORMAL' ? a : b;
    await client.query('UPDATE derivados_operaciones SET id_operacion_espejo=$1,grupo_operacion=$2,impacta_stock=$3,updated_at=NOW() WHERE id=$4', [b.id,grupo,a.id===informal.id,a.id]);
    await client.query('UPDATE derivados_operaciones SET id_operacion_espejo=$1,grupo_operacion=$2,impacta_stock=$3,updated_at=NOW() WHERE id=$4', [a.id,grupo,b.id===informal.id,b.id]);
    await client.query('COMMIT');
    res.json({ ok: true, grupo_operacion: grupo });
  } catch (error) { await client.query('ROLLBACK'); res.status(500).json({ error: error.message }); }
  finally { client.release(); }
});

module.exports = router;
