const router = require('express').Router();
const { pool } = require('../db');
const { registrarAuditoria } = require('../services/auditoria');
const {
  TIPOS_CONCEPTO,
  TIPOS_IMPUESTO,
  normalizarConcepto,
  calcularTotales,
  ensureLiquidacionesGranosSchema
} = require('../services/liquidacionesGranosSchema');

function cuit(value) {
  const normalized = String(value || '').replace(/\D/g, '');
  if (!normalized) return null;
  if (!/^\d{11}$/.test(normalized)) throw new Error(`CUIT invalido: ${value}`);
  return normalized;
}

function numero(value, field, nullable = true) {
  if ((value === null || value === undefined || value === '') && nullable) return null;
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${field} invalido.`);
  return result;
}

async function insertarConceptos(client, idLiquidacion, conceptos = []) {
  for (let index = 0; index < conceptos.length; index += 1) {
    const item = normalizarConcepto(conceptos[index]);
    await client.query(`
      INSERT INTO liquidacion_conceptos
        (id_liquidacion,orden,tipo,codigo_oficial,descripcion,cantidad,unidad,precio_unitario,
         importe_neto,alicuota_iva,importe_iva,importe_total,signo,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
    `, [idLiquidacion, index, item.tipo, item.codigoOficial, item.descripcion, item.cantidad,
      item.unidad, item.precioUnitario, item.importeNeto, item.alicuotaIva, item.importeIva,
      item.importeTotal, item.signo, JSON.stringify(item.metadata)]);
  }
}

async function insertarImpuestos(client, idLiquidacion, impuestos = []) {
  for (let index = 0; index < impuestos.length; index += 1) {
    const item = impuestos[index] || {};
    const tipo = String(item.tipo || 'OTRO').toUpperCase();
    if (!TIPOS_IMPUESTO.includes(tipo)) throw new Error(`Tipo de impuesto invalido: ${tipo}`);
    await client.query(`
      INSERT INTO liquidacion_impuestos
        (id_liquidacion,orden,tipo,regimen,descripcion,base_imponible,alicuota,importe,
         signo,caracter,computabilidad,numero_certificado,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
    `, [idLiquidacion, index, tipo, item.regimen || null, item.descripcion || tipo,
      numero(item.baseImponible ?? item.base_imponible, 'base imponible'),
      numero(item.alicuota, 'alicuota'), numero(item.importe, 'importe', false),
      String(item.signo || 'RESTA').toUpperCase(), String(item.caracter || 'PRACTICADA').toUpperCase(),
      item.computabilidad || null, item.numeroCertificado || item.numero_certificado || null,
      JSON.stringify(item.metadata || {})]);
  }
}

async function crear(req, res, clase) {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const conceptos = Array.isArray(body.conceptos) ? body.conceptos : [];
    const impuestos = Array.isArray(body.impuestos) ? body.impuestos : [];
    if (!conceptos.length) return res.status(400).json({ error: 'La liquidacion debe contener al menos un concepto.' });
    const totales = calcularTotales(conceptos, impuestos);
    await client.query('BEGIN');
    await ensureLiquidacionesGranosSchema(client);
    const year = new Date(body.fechaLiquidacion || body.fecha_liquidacion || Date.now()).getFullYear();
    const prefix = clase === 'PRIMARIA' ? 'LPG' : 'LSG';
    const nro = body.nroLiquidacion || body.nro_liquidacion || `${prefix}-${year}-${Date.now()}`;
    const { rows } = await client.query(`
      INSERT INTO liquidaciones
        (nro_liquidacion,tipo,modalidad,tipo_liquidacion,id_contrato,id_contraparte,
         fecha_liquidacion,monto_bruto_total,total_descuentos_servicios,total_retenciones,
         monto_neto_a_pagar,moneda,estado,observaciones)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'BORRADOR',$13)
      RETURNING *
    `, [nro, body.tipo || 'COMPRA', body.modalidad || 'FORMAL', clase,
      body.idContrato || body.id_contrato || null, body.idContraparte || body.id_contraparte || null,
      body.fechaLiquidacion || body.fecha_liquidacion,
      totales.brutoConceptos, totales.descuentosConceptos, totales.retenciones,
      totales.total, body.moneda || 'PESOS', body.observaciones || null]);
    const id = rows[0].id;
    if (clase === 'PRIMARIA') {
      const data = body.primaria || body;
      await client.query(`
        INSERT INTO liquidaciones_primarias
          (id_liquidacion,coe,numero_lpg,cuit_liquidador,cuit_productor,id_certificado_1116,
           kilos_brutos,kilos_netos,kilos_liquidados,precio_tonelada,fecha_operacion,fecha_pago,metadata_oficial)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
      `, [id, data.coe || null, data.numeroLpg || data.numero_lpg || null, cuit(data.cuitLiquidador || data.cuit_liquidador),
        cuit(data.cuitProductor || data.cuit_productor), data.idCertificado1116 || data.id_certificado_1116 || null,
        numero(data.kilosBrutos ?? data.kilos_brutos, 'kilos brutos'), numero(data.kilosNetos ?? data.kilos_netos, 'kilos netos'),
        numero(data.kilosLiquidados ?? data.kilos_liquidados, 'kilos liquidados'), numero(data.precioTonelada ?? data.precio_tonelada, 'precio tonelada'),
        data.fechaOperacion || data.fecha_operacion || null, data.fechaPago || data.fecha_pago || null,
        JSON.stringify(data.metadataOficial || data.metadata_oficial || {})]);
    } else {
      const data = body.secundaria || body;
      await client.query(`
        INSERT INTO liquidaciones_secundarias
          (id_liquidacion,coe,numero_lsg,cuit_emisor,cuit_vendedor,cuit_comprador,
           cuit_corredor_consignatario,kilos_liquidados,precio_tonelada,fecha_operacion,fecha_pago,metadata_oficial)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
      `, [id, data.coe || null, data.numeroLsg || data.numero_lsg || null, cuit(data.cuitEmisor || data.cuit_emisor),
        cuit(data.cuitVendedor || data.cuit_vendedor), cuit(data.cuitComprador || data.cuit_comprador),
        cuit(data.cuitCorredorConsignatario || data.cuit_corredor_consignatario),
        numero(data.kilosLiquidados ?? data.kilos_liquidados, 'kilos liquidados'), numero(data.precioTonelada ?? data.precio_tonelada, 'precio tonelada'),
        data.fechaOperacion || data.fecha_operacion || null, data.fechaPago || data.fecha_pago || null,
        JSON.stringify(data.metadataOficial || data.metadata_oficial || {})]);
    }
    await insertarConceptos(client, id, conceptos);
    await insertarImpuestos(client, id, impuestos);
    await client.query('COMMIT');
    await registrarAuditoria(req, { accion: 'CREAR', modulo: 'liquidaciones_granos', registro_id: id, datos_despues: { clase, ...rows[0], totales } });
    res.status(201).json({ ...rows[0], clase, totales });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
}

router.post('/primarias', (req, res) => crear(req, res, 'PRIMARIA'));
router.post('/secundarias', (req, res) => crear(req, res, 'SECUNDARIA'));

router.get('/catalogos/conceptos', (req, res) => res.json({ conceptos: TIPOS_CONCEPTO, impuestos: TIPOS_IMPUESTO }));

router.get('/:id', async (req, res) => {
  try {
    await ensureLiquidacionesGranosSchema(pool);
    const { rows } = await pool.query(`
      SELECT l.*,TO_JSONB(lp.*)-'id'-'id_liquidacion' primaria,
        TO_JSONB(ls.*)-'id'-'id_liquidacion' secundaria
      FROM liquidaciones l
      LEFT JOIN liquidaciones_primarias lp ON lp.id_liquidacion=l.id
      LEFT JOIN liquidaciones_secundarias ls ON ls.id_liquidacion=l.id
      WHERE l.id=$1
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Liquidacion no encontrada.' });
    const [conceptos, impuestos, relaciones] = await Promise.all([
      pool.query('SELECT * FROM liquidacion_conceptos WHERE id_liquidacion=$1 ORDER BY orden,id', [req.params.id]),
      pool.query('SELECT * FROM liquidacion_impuestos WHERE id_liquidacion=$1 ORDER BY orden,id', [req.params.id]),
      pool.query('SELECT * FROM liquidacion_relaciones WHERE id_liquidacion=$1 ORDER BY id', [req.params.id])
    ]);
    res.json({ ...rows[0], conceptos: conceptos.rows, impuestos: impuestos.rows, relaciones: relaciones.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

