const { pool } = require('../db');
const { ensureLiquidacionesGranosSchema } = require('./liquidacionesGranosSchema');

const COE_RE = /\b(33[01]\d{9})\b/;

function normalizarNombre(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function escalares(node, path = '', result = []) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => escalares(item, `${path}[${index}]`, result));
  } else if (node && typeof node === 'object') {
    Object.entries(node).forEach(([key, value]) => escalares(value, path ? `${path}.${key}` : key, result));
  } else if (node !== undefined && node !== null) {
    result.push({ path, key: normalizarNombre(path.split('.').pop()), value: node });
  }
  return result;
}

function obtenerCoe(documento) {
  const external = String(documento.external_key || '').match(COE_RE)?.[1];
  if (external) return external;
  const fields = escalares(documento.payload || {});
  for (const field of fields) {
    if (!field.key.includes('coe')) continue;
    const coe = String(field.value || '').match(COE_RE)?.[1];
    if (coe) return coe;
  }
  return null;
}

function indicePayload(payload) {
  const fields = escalares(payload || {});
  const find = names => {
    const normalized = names.map(normalizarNombre);
    const exact = fields.find(field => normalized.includes(field.key));
    return exact?.value ?? null;
  };
  return { fields, find };
}

function numero(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().replace(/\s/g, '');
  const normalized = text.includes(',')
    ? text.replace(/\./g, '').replace(',', '.')
    : text;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function cuit(value) {
  const result = String(value || '').replace(/\D/g, '');
  return /^\d{11}$/.test(result) ? result : null;
}

function fecha(value, fallback = null) {
  if (!value) return fallback;
  const text = String(value).trim();
  const dmy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString().slice(0, 10);
}

function resumirDocumento(documento) {
  const coe = obtenerCoe(documento);
  if (!coe) return null;
  const payload = documento.payload || {};
  const { fields, find } = indicePayload(payload);
  const clase = coe.startsWith('330') ? 'PRIMARIA' : 'SECUNDARIA';
  const descripcionOperacion = find(['tipoOperacion', 'descripcionOperacion', 'operacion', 'descripcion']);
  const esAjuste = /ajuste|nota\s+de\s+(credito|d[eé]bito)|contra\s*documento/i
    .test(String(descripcionOperacion || ''));
  const tipo = /venta/i.test(String(descripcionOperacion || '')) ? 'VENTA' : 'COMPRA';
  const fechaDocumento = fecha(
    find(['fechaEmision', 'fechaLiquidacion', 'fechaOperacion', 'fecha']),
    fecha(documento.document_date, new Date().toISOString().slice(0, 10))
  );
  return {
    coe,
    clase,
    tipo,
    fecha: fechaDocumento,
    payload,
    fields,
    fuente: documento.fuente,
    documentId: documento.id,
    payloadHash: documento.payload_hash,
    descripcionOperacion: descripcionOperacion ? String(descripcionOperacion) : null,
    esAjuste,
    coePrincipal: String(find(['coeOriginal', 'coeOrigen', 'coeLiquidacionOriginal',
      'coeAjustado', 'coeRelacionado']) || '').match(COE_RE)?.[1] || null,
    estado: find(['estado', 'estadoOficial']),
    sistema: find(['sistema', 'sistemaEmision']),
    moneda: find(['moneda', 'codigoMoneda']) || 'PESOS',
    kilos: numero(find(['kilosLiquidados', 'pesoNeto', 'kgNeto', 'cantidadKilos'])),
    precio: numero(find(['precioTonelada', 'precioTn', 'precio'])),
    importeBruto: numero(find(['importeBruto', 'montoBruto', 'importeNetoGravado'])),
    importeIva: numero(find(['importeIva', 'iva'])),
    importeTotal: numero(find(['importeTotal', 'montoTotal', 'total'])),
    cuitLiquidador: cuit(find(['cuitLiquidador', 'cuitEmisor', 'cuitComprador'])),
    cuitProductor: cuit(find(['cuitProductor', 'cuitVendedor', 'cuitReceptor'])),
    cuitEmisor: cuit(find(['cuitEmisor', 'cuitLiquidador'])),
    cuitVendedor: cuit(find(['cuitVendedor', 'cuitProductor'])),
    cuitComprador: cuit(find(['cuitComprador'])),
    cuitCorredor: cuit(find(['cuitCorredorConsignatario', 'cuitCorredor', 'cuitConsignatario']))
  };
}

function coeContraDocumento(value) {
  const text = String(value || '');
  if (!/contra\s*documento/i.test(text)) return null;
  return text.match(COE_RE)?.[1] || null;
}

async function guardarDocumento(client, data) {
  const existing = await client.query(`
    SELECT id_liquidacion FROM liquidaciones_primarias WHERE coe=$1
    UNION ALL
    SELECT id_liquidacion FROM liquidaciones_secundarias WHERE coe=$1
    LIMIT 1
  `, [data.coe]);

  let idLiquidacion = existing.rows[0]?.id_liquidacion || null;
  let created = false;
  if (!idLiquidacion) {
    const inserted = await client.query(`
      INSERT INTO liquidaciones
        (nro_liquidacion,tipo,modalidad,tipo_liquidacion,fecha_liquidacion,
         monto_bruto_total,total_descuentos_servicios,total_retenciones,monto_neto_a_pagar,
         moneda,estado,observaciones)
      VALUES($1,$2,'FORMAL',$3,$4,$5,0,0,$6,$7,'BORRADOR',$8)
      ON CONFLICT(nro_liquidacion) DO UPDATE SET updated_at=NOW()
      RETURNING id
    `, [`ARCA-${data.coe}`, data.tipo, data.clase, data.fecha, data.importeBruto,
      data.importeTotal, data.moneda, `Importada desde ${data.fuente}; pendiente de revision humana.`]);
    idLiquidacion = inserted.rows[0].id;
    created = true;
  }

  if (data.clase === 'PRIMARIA') {
    await client.query(`
      INSERT INTO liquidaciones_primarias
        (id_liquidacion,coe,numero_lpg,cuit_liquidador,cuit_productor,kilos_liquidados,
         precio_tonelada,fecha_operacion,metadata_oficial)
      VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8::jsonb)
      ON CONFLICT(coe) WHERE coe IS NOT NULL AND coe <> '' DO UPDATE SET
        cuit_liquidador=COALESCE(EXCLUDED.cuit_liquidador,liquidaciones_primarias.cuit_liquidador),
        cuit_productor=COALESCE(EXCLUDED.cuit_productor,liquidaciones_primarias.cuit_productor),
        kilos_liquidados=COALESCE(EXCLUDED.kilos_liquidados,liquidaciones_primarias.kilos_liquidados),
        precio_tonelada=COALESCE(EXCLUDED.precio_tonelada,liquidaciones_primarias.precio_tonelada),
        metadata_oficial=EXCLUDED.metadata_oficial,updated_at=NOW()
    `, [idLiquidacion, data.coe, data.cuitLiquidador, data.cuitProductor, data.kilos,
      data.precio, data.fecha, JSON.stringify(data.payload)]);
  } else {
    await client.query(`
      INSERT INTO liquidaciones_secundarias
        (id_liquidacion,coe,numero_lsg,cuit_emisor,cuit_vendedor,cuit_comprador,
         cuit_corredor_consignatario,kilos_liquidados,precio_tonelada,fecha_operacion,metadata_oficial)
      VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
      ON CONFLICT(coe) WHERE coe IS NOT NULL AND coe <> '' DO UPDATE SET
        cuit_emisor=COALESCE(EXCLUDED.cuit_emisor,liquidaciones_secundarias.cuit_emisor),
        cuit_vendedor=COALESCE(EXCLUDED.cuit_vendedor,liquidaciones_secundarias.cuit_vendedor),
        cuit_comprador=COALESCE(EXCLUDED.cuit_comprador,liquidaciones_secundarias.cuit_comprador),
        cuit_corredor_consignatario=COALESCE(EXCLUDED.cuit_corredor_consignatario,liquidaciones_secundarias.cuit_corredor_consignatario),
        kilos_liquidados=COALESCE(EXCLUDED.kilos_liquidados,liquidaciones_secundarias.kilos_liquidados),
        precio_tonelada=COALESCE(EXCLUDED.precio_tonelada,liquidaciones_secundarias.precio_tonelada),
        metadata_oficial=EXCLUDED.metadata_oficial,updated_at=NOW()
    `, [idLiquidacion, data.coe, data.cuitEmisor, data.cuitVendedor, data.cuitComprador,
      data.cuitCorredor, data.kilos, data.precio, data.fecha, JSON.stringify(data.payload)]);
  }

  await client.query(`
    INSERT INTO liquidacion_datos_oficiales
      (id_liquidacion,fuente,familia_documento,descripcion_operacion,sistema_emision,
       estado_oficial,fecha_emision,moneda,importe_bruto,importe_iva,importe_total,
       payload_oficial,payload_hash,sincronizado_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,NOW())
    ON CONFLICT(id_liquidacion) DO UPDATE SET
      fuente=EXCLUDED.fuente,familia_documento=EXCLUDED.familia_documento,
      descripcion_operacion=EXCLUDED.descripcion_operacion,sistema_emision=EXCLUDED.sistema_emision,
      estado_oficial=EXCLUDED.estado_oficial,fecha_emision=EXCLUDED.fecha_emision,
      moneda=EXCLUDED.moneda,importe_bruto=EXCLUDED.importe_bruto,
      importe_iva=EXCLUDED.importe_iva,importe_total=EXCLUDED.importe_total,
      payload_oficial=EXCLUDED.payload_oficial,payload_hash=EXCLUDED.payload_hash,
      sincronizado_at=NOW(),updated_at=NOW()
  `, [idLiquidacion, data.fuente, data.clase === 'PRIMARIA' ? 'LPG' : 'LSG',
    data.descripcionOperacion, data.sistema, data.estado, data.fecha, data.moneda,
    data.importeBruto, data.importeIva, data.importeTotal, JSON.stringify(data.payload), data.payloadHash]);

  await client.query(`
    INSERT INTO liquidacion_relaciones(id_liquidacion,id_documento_arca,tipo_relacion,metadata)
    SELECT $1,$2,'DOCUMENTO_OFICIAL',$3::jsonb
    WHERE NOT EXISTS (
      SELECT 1 FROM liquidacion_relaciones
      WHERE id_liquidacion=$1 AND id_documento_arca=$2 AND tipo_relacion='DOCUMENTO_OFICIAL'
    )
  `, [idLiquidacion, data.documentId, JSON.stringify({ fuente: data.fuente, coe: data.coe })]);

  for (let index = 0; index < data.fields.length; index += 1) {
    const field = data.fields[index];
    const numeric = typeof field.value === 'number' && Number.isFinite(field.value) ? field.value : null;
    const boolean = typeof field.value === 'boolean' ? field.value : null;
    await client.query(`
      INSERT INTO liquidacion_campos_oficiales
        (id_liquidacion,ruta,campo,ocurrencia,tipo_dato,valor_texto,valor_numero,valor_booleano)
      VALUES($1,$2,$3,0,$4,$5,$6,$7)
      ON CONFLICT(id_liquidacion,ruta,ocurrencia) DO UPDATE SET
        tipo_dato=EXCLUDED.tipo_dato,valor_texto=EXCLUDED.valor_texto,
        valor_numero=EXCLUDED.valor_numero,valor_booleano=EXCLUDED.valor_booleano
    `, [idLiquidacion, field.path || `campo[${index}]`, field.key || 'campo',
      boolean !== null ? 'BOOLEANO' : numeric !== null ? 'NUMERO' : 'TEXTO',
      numeric === null && boolean === null ? String(field.value) : null, numeric, boolean]);
  }
  return created;
}

async function relacionarAjuste(client, idLiquidacion, principalCoe, ajuste) {
  await client.query(`
    INSERT INTO liquidacion_relaciones(id_liquidacion,id_documento_arca,tipo_relacion,metadata)
    SELECT $1,$2,'AJUSTE_OFICIAL',$3::jsonb
    WHERE NOT EXISTS (
      SELECT 1 FROM liquidacion_relaciones
      WHERE id_liquidacion=$1 AND id_documento_arca=$2 AND tipo_relacion='AJUSTE_OFICIAL'
    )
  `, [idLiquidacion, ajuste.documentId, JSON.stringify({
    coePrincipal: principalCoe,
    coeAjuste: ajuste.coe,
    descripcionOperacion: ajuste.descripcionOperacion,
    estado: ajuste.estado,
    payload: ajuste.payload
  })]);

  await client.query(`
    INSERT INTO liquidacion_referencias(id_liquidacion,tipo,numero,fecha,importe,metadata)
    SELECT $1,'COE_AJUSTE',$2,$3,$4,$5::jsonb
    WHERE NOT EXISTS (
      SELECT 1 FROM liquidacion_referencias
      WHERE id_liquidacion=$1 AND tipo='COE_AJUSTE' AND numero=$2
    )
  `, [idLiquidacion, ajuste.coe, ajuste.fecha, ajuste.importeTotal,
    JSON.stringify({ fuente: ajuste.fuente, estado: ajuste.estado })]);

  for (let index = 0; index < ajuste.fields.length; index += 1) {
    const field = ajuste.fields[index];
    const numeric = typeof field.value === 'number' && Number.isFinite(field.value) ? field.value : null;
    const boolean = typeof field.value === 'boolean' ? field.value : null;
    const ruta = `ajustes[${ajuste.coe}].${field.path || `campo[${index}]`}`;
    await client.query(`
      INSERT INTO liquidacion_campos_oficiales
        (id_liquidacion,ruta,campo,ocurrencia,tipo_dato,valor_texto,valor_numero,valor_booleano)
      VALUES($1,$2,$3,0,$4,$5,$6,$7)
      ON CONFLICT(id_liquidacion,ruta,ocurrencia) DO UPDATE SET
        tipo_dato=EXCLUDED.tipo_dato,valor_texto=EXCLUDED.valor_texto,
        valor_numero=EXCLUDED.valor_numero,valor_booleano=EXCLUDED.valor_booleano
    `, [idLiquidacion, ruta, field.key || 'campo',
      boolean !== null ? 'BOOLEANO' : numeric !== null ? 'NUMERO' : 'TEXTO',
      numeric === null && boolean === null ? String(field.value) : null, numeric, boolean]);
  }
}

async function materializarLiquidacionesOficiales() {
  const client = await pool.connect();
  const result = { oficiales: 0, coeUnicos: 0, principales: 0, creadas: 0,
    actualizadas: 0, ajustesVinculados: 0, ajustesPendientes: [], omitidas: 0, errores: [] };
  try {
    await client.query('BEGIN');
    await ensureLiquidacionesGranosSchema(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('granosys:materializar-liquidaciones-arca'))");
    const { rows } = await client.query(`
      SELECT id,fuente,external_key,document_date,payload,payload_hash,last_seen_at
      FROM arca_official_documents
      WHERE (external_key ~ '33[01][0-9]{9}' OR payload::text ~ '33[01][0-9]{9}')
        AND (fuente LIKE 'WSLPG_%' OR fuente LIKE 'ARCA_%')
      ORDER BY last_seen_at DESC,id DESC
    `);
    result.oficiales = rows.length;
    const unique = new Map();
    for (const row of rows) {
      const data = resumirDocumento(row);
      if (!data) { result.omitidas += 1; continue; }
      if (!unique.has(data.coe)) unique.set(data.coe, data);
    }
    result.coeUnicos = unique.size;
    const contraAPrincipal = new Map();
    for (const data of unique.values()) {
      const contraCoe = coeContraDocumento(data.estado);
      if (contraCoe) contraAPrincipal.set(contraCoe, data.coe);
    }
    const principales = [...unique.values()].filter(data => !data.esAjuste);
    result.principales = principales.length;
    for (const data of principales) {
      const savepoint = `liq_${data.coe}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const created = await guardarDocumento(client, data);
        if (created) result.creadas += 1;
        else result.actualizadas += 1;
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        result.errores.push({ coe: data.coe, error: error.message });
      }
    }
    for (const ajuste of [...unique.values()].filter(data => data.esAjuste)) {
      const principalCoe = ajuste.coePrincipal || contraAPrincipal.get(ajuste.coe) || null;
      if (!principalCoe) {
        result.ajustesPendientes.push({ coe: ajuste.coe, motivo: 'COE principal no informado por ARCA' });
        continue;
      }
      const parent = await client.query(`
        SELECT id_liquidacion FROM liquidaciones_primarias WHERE coe=$1
        UNION ALL
        SELECT id_liquidacion FROM liquidaciones_secundarias WHERE coe=$1
        LIMIT 1
      `, [principalCoe]);
      if (!parent.rows[0]) {
        result.ajustesPendientes.push({ coe: ajuste.coe, coePrincipal: principalCoe,
          motivo: 'La liquidacion principal todavia no esta disponible' });
        continue;
      }
      const savepoint = `ajuste_${ajuste.coe}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        await relacionarAjuste(client, parent.rows[0].id_liquidacion, principalCoe, ajuste);
        result.ajustesVinculados += 1;
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        result.errores.push({ coe: ajuste.coe, coePrincipal: principalCoe, error: error.message });
      }
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  escalares,
  obtenerCoe,
  coeContraDocumento,
  resumirDocumento,
  materializarLiquidacionesOficiales
};
