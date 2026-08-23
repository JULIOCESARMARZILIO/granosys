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
const { generarAsientoLiquidacion } = require('../services/contabilidadLiquidaciones');
const { materializarLiquidacionesOficiales } = require('../services/arcaLiquidationMaterializer');

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

const CAMPOS_SENSIBLES = /(^|_)(token|sign|firma|password|clave|privatekey|certificadope?m|pdfbase64|rawxml)($|_)/i;

function limpiarPayload(node) {
  if (Array.isArray(node)) return node.map(limpiarPayload);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node)
    .filter(([key]) => !CAMPOS_SENSIBLES.test(key.replace(/[^a-z0-9]/gi, '_')))
    .map(([key, value]) => [key, limpiarPayload(value)]));
}

function camposEscalares(node, path = '', result = []) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => camposEscalares(item, `${path}[${index}]`, result));
  } else if (node && typeof node === 'object') {
    Object.entries(node).forEach(([key, value]) => camposEscalares(value, path ? `${path}.${key}` : key, result));
  } else if (node !== undefined && node !== null) {
    result.push({ ruta: path, campo: path.split('.').pop().replace(/\[\d+\]/g, ''), valor: node });
  }
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

async function insertarDetalleOficial(client, idLiquidacion, body) {
  const oficial = body.datosOficiales || body.datos_oficiales || {};
  const payload = limpiarPayload(oficial.payloadOficial || oficial.payload_oficial || body.payloadOficial || {});
  await client.query(`
    INSERT INTO liquidacion_datos_oficiales
      (id_liquidacion,fuente,familia_documento,tipo_formulario_historico,codigo_operacion,
       descripcion_operacion,sistema_emision,estado_oficial,fecha_emision,fecha_anulacion,
       punto_emision,numero_comprobante,moneda,tipo_cambio,importe_bruto,importe_neto_gravado,
       importe_no_gravado,importe_exento,importe_iva,importe_tributos,importe_retenciones,
       importe_percepciones,importe_total,saldo_pagable,payload_oficial,payload_hash,
       version_esquema,sincronizado_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,$26,$27,$28)
  `, [idLiquidacion, oficial.fuente || null, oficial.familiaDocumento || oficial.familia_documento || null,
    oficial.tipoFormularioHistorico || oficial.tipo_formulario_historico || null,
    oficial.codigoOperacion || oficial.codigo_operacion || null, oficial.descripcionOperacion || oficial.descripcion_operacion || null,
    oficial.sistemaEmision || oficial.sistema_emision || null, oficial.estadoOficial || oficial.estado_oficial || null,
    oficial.fechaEmision || oficial.fecha_emision || null, oficial.fechaAnulacion || oficial.fecha_anulacion || null,
    numero(oficial.puntoEmision ?? oficial.punto_emision, 'punto de emision'),
    numero(oficial.numeroComprobante ?? oficial.numero_comprobante, 'numero de comprobante'),
    oficial.moneda || body.moneda || null, numero(oficial.tipoCambio ?? oficial.tipo_cambio, 'tipo de cambio'),
    numero(oficial.importeBruto ?? oficial.importe_bruto, 'importe bruto'),
    numero(oficial.importeNetoGravado ?? oficial.importe_neto_gravado, 'neto gravado'),
    numero(oficial.importeNoGravado ?? oficial.importe_no_gravado, 'no gravado'),
    numero(oficial.importeExento ?? oficial.importe_exento, 'exento'), numero(oficial.importeIva ?? oficial.importe_iva, 'IVA'),
    numero(oficial.importeTributos ?? oficial.importe_tributos, 'tributos'),
    numero(oficial.importeRetenciones ?? oficial.importe_retenciones, 'retenciones'),
    numero(oficial.importePercepciones ?? oficial.importe_percepciones, 'percepciones'),
    numero(oficial.importeTotal ?? oficial.importe_total, 'importe total'),
    numero(oficial.saldoPagable ?? oficial.saldo_pagable, 'saldo pagable'), JSON.stringify(payload),
    oficial.payloadHash || oficial.payload_hash || null, oficial.versionEsquema || oficial.version_esquema || null,
    oficial.sincronizadoAt || oficial.sincronizado_at || null]);

  const participantes = Array.isArray(body.participantes) ? body.participantes : [];
  for (let i = 0; i < participantes.length; i += 1) {
    const p = participantes[i] || {};
    await client.query(`INSERT INTO liquidacion_participantes
      (id_liquidacion,orden,rol,cuit,razon_social,id_contraparte,nro_planta,actividad,domicilio,localidad,provincia,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [idLiquidacion,i,p.rol || 'OTRO',cuit(p.cuit),p.razonSocial || p.razon_social || null,
      p.idContraparte || p.id_contraparte || null,p.nroPlanta || p.nro_planta || null,p.actividad || null,
      p.domicilio || null,p.localidad || null,p.provincia || null,JSON.stringify(p.metadata || {})]);
  }

  const items = Array.isArray(body.items) ? body.items : [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] || {};
    await client.query(`INSERT INTO liquidacion_items
      (id_liquidacion,orden,codigo_producto,descripcion_producto,campana,grado,cosecha,procedencia,destino,
       coe_certificado,ctg,kilos_brutos,kilos_merma,kilos_netos,kilos_netos_acondicionados,kilos_liquidados,
       precio_tonelada,importe_bruto,importe_ajustes_calidad,importe_neto,calidad,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22::jsonb)`,
    [idLiquidacion,i,item.codigoProducto || item.codigo_producto || null,item.descripcionProducto || item.descripcion_producto || item.producto || null,
      item.campana || null,item.grado || null,item.cosecha || null,item.procedencia || null,item.destino || null,
      item.coeCertificado || item.coe_certificado || null,item.ctg || null,numero(item.kilosBrutos ?? item.kilos_brutos,'kilos brutos'),
      numero(item.kilosMerma ?? item.kilos_merma,'kilos merma'),numero(item.kilosNetos ?? item.kilos_netos,'kilos netos'),
      numero(item.kilosNetosAcondicionados ?? item.kilos_netos_acondicionados,'kilos acondicionados'),
      numero(item.kilosLiquidados ?? item.kilos_liquidados,'kilos liquidados'),numero(item.precioTonelada ?? item.precio_tonelada,'precio tonelada'),
      numero(item.importeBruto ?? item.importe_bruto,'importe bruto'),numero(item.importeAjustesCalidad ?? item.importe_ajustes_calidad,'ajustes calidad'),
      numero(item.importeNeto ?? item.importe_neto,'importe neto'),JSON.stringify(item.calidad || {}),JSON.stringify(item.metadata || {})]);
  }

  const referencias = Array.isArray(body.referencias) ? body.referencias : [];
  for (let i = 0; i < referencias.length; i += 1) {
    const ref = referencias[i] || {};
    await client.query(`INSERT INTO liquidacion_referencias
      (id_liquidacion,orden,tipo,numero,fecha,kilos,importe,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [idLiquidacion,i,ref.tipo || 'OTRO',String(ref.numero || ''),ref.fecha || null,numero(ref.kilos,'kilos'),
      numero(ref.importe,'importe'),JSON.stringify(ref.metadata || {})]);
  }

  const campos = Array.isArray(body.camposOficiales) ? body.camposOficiales : camposEscalares(payload);
  for (let i = 0; i < campos.length; i += 1) {
    const campo = campos[i] || {};
    const value = campo.valor;
    const numeric = typeof value === 'number' && Number.isFinite(value) ? value : null;
    const boolean = typeof value === 'boolean' ? value : null;
    await client.query(`INSERT INTO liquidacion_campos_oficiales
      (id_liquidacion,ruta,campo,ocurrencia,tipo_dato,valor_texto,valor_numero,valor_booleano,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(id_liquidacion,ruta,ocurrencia) DO NOTHING`,
    [idLiquidacion,campo.ruta || campo.campo || `campo[${i}]`,campo.campo || 'campo',campo.ocurrencia || 0,
      boolean !== null ? 'BOOLEANO' : numeric !== null ? 'NUMERO' : 'TEXTO',
      numeric === null && boolean === null ? String(value ?? '') : null,numeric,boolean,JSON.stringify(campo.metadata || {})]);
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
    await insertarDetalleOficial(client, id, body);
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

// Materializa documentos oficiales ya consultados. Es idempotente por COE,
// no emite documentos y deja cada liquidacion en BORRADOR para revision humana.
router.post('/sincronizar-oficiales', async (req, res) => {
  try {
    const resultado = await materializarLiquidacionesOficiales();
    await registrarAuditoria(req, { accion: 'SINCRONIZAR', modulo: 'liquidaciones_granos',
      datos_despues: resultado });
    res.json({ ok: true, resultado, soloConsultaArca: true, generaAsientos: false });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/:id/asiento-borrador', async (req, res) => {
  try {
    const asiento = await generarAsientoLiquidacion(req.params.id, req.user?.id || null);
    await registrarAuditoria(req, { accion: 'GENERAR_BORRADOR', modulo: 'contabilidad',
      registro_id: asiento.id, datos_despues: asiento });
    res.status(201).json(asiento);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/:id/asiento', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT a.*,COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT(
      'id',r.id,'orden',r.orden,'cuenta',pc.codigo,'cuenta_nombre',pc.nombre,
      'descripcion',r.descripcion,'debe',r.debe,'haber',r.haber,'impuesto_id',r.id_liquidacion_impuesto,
      'concepto_id',r.id_liquidacion_concepto) ORDER BY r.orden,r.id)
      FILTER(WHERE r.id IS NOT NULL),'[]'::jsonb) renglones
      FROM asientos_contables a LEFT JOIN asiento_renglones r ON r.id_asiento=a.id
      LEFT JOIN plan_cuentas pc ON pc.id=r.id_cuenta
      WHERE a.origen_modulo='LIQUIDACIONES_GRANOS' AND a.origen_id=$1 GROUP BY a.id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Asiento no encontrado.' });
    res.json(rows[0]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

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
    const [conceptos, impuestos, relaciones, participantes, items, referencias, campos, oficial] = await Promise.all([
      pool.query('SELECT * FROM liquidacion_conceptos WHERE id_liquidacion=$1 ORDER BY orden,id', [req.params.id]),
      pool.query('SELECT * FROM liquidacion_impuestos WHERE id_liquidacion=$1 ORDER BY orden,id', [req.params.id]),
      pool.query('SELECT * FROM liquidacion_relaciones WHERE id_liquidacion=$1 ORDER BY id', [req.params.id]),
      pool.query('SELECT * FROM liquidacion_participantes WHERE id_liquidacion=$1 ORDER BY orden,id', [req.params.id]),
      pool.query('SELECT * FROM liquidacion_items WHERE id_liquidacion=$1 ORDER BY orden,id', [req.params.id]),
      pool.query('SELECT * FROM liquidacion_referencias WHERE id_liquidacion=$1 ORDER BY orden,id', [req.params.id]),
      pool.query('SELECT * FROM liquidacion_campos_oficiales WHERE id_liquidacion=$1 ORDER BY ruta,ocurrencia,id', [req.params.id]),
      pool.query('SELECT * FROM liquidacion_datos_oficiales WHERE id_liquidacion=$1', [req.params.id])
    ]);
    res.json({ ...rows[0], datosOficiales: oficial.rows[0] || null, participantes: participantes.rows,
      items: items.rows, conceptos: conceptos.rows, impuestos: impuestos.rows,
      referencias: referencias.rows, relaciones: relaciones.rows, camposOficiales: campos.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

