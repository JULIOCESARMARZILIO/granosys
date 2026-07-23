const router = require('express').Router();
const { pool } = require('../db');

// Si viene precio de referencia + descuento %, calcula el precio final descontado.
// Si no hay descuento pero sí referencia y precio manual, calcula el descuento % equivalente para mostrarlo.
function resolverPrecioConDescuento(precioReferencia, descuentoPct, precioManual) {
  const ref = precioReferencia !== undefined && precioReferencia !== null && precioReferencia !== ''
    ? parseFloat(precioReferencia) : null;
  const desc = descuentoPct !== undefined && descuentoPct !== null && descuentoPct !== ''
    ? parseFloat(descuentoPct) : null;
  const manual = precioManual !== undefined && precioManual !== null && precioManual !== ''
    ? parseFloat(precioManual) : null;

  if (ref !== null && !isNaN(ref) && desc !== null && !isNaN(desc)) {
    return { precio: ref * (1 - desc / 100), descuento: desc, referencia: ref };
  }
  if (ref !== null && !isNaN(ref) && ref > 0 && manual !== null && !isNaN(manual)) {
    return { precio: manual, descuento: (1 - manual / ref) * 100, referencia: ref };
  }
  return { precio: manual, descuento: null, referencia: ref };
}

// Recalcula y actualiza la cantidad de toneladas asignadas y el estado de un contrato
async function recalcularContrato(id_contrato) {
  if (!id_contrato) return;
  const client = await pool.connect();
  try {
    const { rows: contractRows } = await client.query(
      'SELECT tipo_contrato, cantidad_toneladas_pactadas, base_calculo_peso FROM contratos WHERE id = $1',
      [id_contrato]
    );
    if (contractRows.length === 0) return;
    const { tipo_contrato, cantidad_toneladas_pactadas, base_calculo_peso } = contractRows[0];

    let fieldToSum = 'peso_neto_salida_kg';
    if (base_calculo_peso === 'BRUTO_DESCARGA') {
      fieldToSum = 'peso_neto_llegada_kg';
    } else if (base_calculo_peso === 'NETO_ACONDICIONADO') {
      fieldToSum = 'kg_liquidables';
    }

    let sumQuery = '';
    if (tipo_contrato === 'COMPRA') {
      sumQuery = `SELECT COALESCE(SUM(${fieldToSum}), 0) as total_kg FROM movimientos WHERE id_contrato_compra = $1`;
    } else {
      sumQuery = `SELECT COALESCE(SUM(${fieldToSum}), 0) as total_kg FROM movimientos WHERE id_contrato_venta = $1`;
    }

    const { rows: sumRows } = await client.query(sumQuery, [id_contrato]);
    const total_toneladas = parseFloat(sumRows[0].total_kg) / 1000;

    let estado = 'CONFIRMADO';
    if (total_toneladas >= parseFloat(cantidad_toneladas_pactadas)) {
      estado = 'CUMPLIDO';
    } else if (total_toneladas > 0) {
      estado = 'EN_CURSO';
    }

    await client.query(
      `UPDATE contratos SET
         cantidad_toneladas_asignadas = $1,
         estado = $2,
         updated_at = NOW()
       WHERE id = $3`,
      [total_toneladas, estado, id_contrato]
    );
  } catch (err) {
    console.error(`Error al recalcular contrato ${id_contrato}:`, err);
  } finally {
    client.release();
  }
}

// GET todos los contratos
router.get('/', async (req, res) => {
  try {
    const modalidad = req.query.modalidad || req.query.modulo;
    const { tipo, estado } = req.query;

    if (tipo === 'CANJE') {
      const { rows } = await pool.query(`
        SELECT c.*, cp.razon_social as contraparte_nombre, 
               e.nombre as especie_nombre, ca.descripcion as campana_desc
        FROM contratos c
        LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
        LEFT JOIN especies e ON c.id_especie = e.id
        LEFT JOIN campanas ca ON c.id_campana = ca.id
        WHERE c.activo = TRUE AND c.es_canje = TRUE
        ORDER BY c.created_at DESC
      `);
      
      const grouped = [];
      const visited = new Set();
      
      for (const row of rows) {
        if (visited.has(row.id)) continue;
        const related = rows.find(r => r.id === row.id_contrato_canje_relacionado);
        if (related) {
          visited.add(related.id);
          visited.add(row.id);
          
          const compra = row.tipo_contrato === 'COMPRA' ? row : related;
          const venta = row.tipo_contrato === 'VENTA' ? row : related;
          
          grouped.push({
            id: compra.id,
            id_compra: compra.id,
            id_venta: venta.id,
            numero: `${compra.numero_contrato} / ${venta.numero_contrato}`,
            numero_contrato: `${compra.numero_contrato} / ${venta.numero_contrato}`,
            fecha: compra.fecha_contrato ? compra.fecha_contrato.toISOString().split('T')[0] : '',
            fecha_contrato: compra.fecha_contrato,
            id_contraparte: compra.id_contraparte,
            contraparte: compra.contraparte_nombre,
            contraparte_nombre: compra.contraparte_nombre,
            campana: compra.campana_desc,
            id_campana: compra.id_campana,
            estado: compra.estado,
            es_canje: true,
            descripcion_relacion_canje: compra.descripcion_relacion_canje || `Canje ${compra.especie_nombre} x ${venta.especie_nombre}`,
            compra: {
              id: compra.id,
              numero: compra.numero_contrato,
              especie: compra.especie_nombre,
              id_especie: compra.id_especie,
              toneladas: parseFloat(compra.cantidad_toneladas_pactadas) || 0,
              asignadas: parseFloat(compra.cantidad_toneladas_asignadas) || 0,
              localidad_entrega: compra.localidad_entrega,
              costo_secada_punto: parseFloat(compra.costo_secada_punto) || 0,
              costo_zarandeo_tn: parseFloat(compra.costo_zarandeo_tn) || 0,
              costo_paritaria_tn: parseFloat(compra.costo_paritaria_tn) || 0,
              costo_fumigacion_fijo: parseFloat(compra.costo_fumigacion_fijo) || 0,
              humedad_max_seco: parseFloat(compra.humedad_max_seco) || 13.5,
              otros_descripcion: compra.otros_descripcion,
              costo_secada_destino_punto: parseFloat(compra.costo_secada_destino_punto) || 0,
              costo_zarandeo_destino_tn: parseFloat(compra.costo_zarandeo_destino_tn) || 0,
              costo_paritaria_destino_tn: parseFloat(compra.costo_paritaria_destino_tn) || 0,
              costo_fumigacion_destino_fijo: parseFloat(compra.costo_fumigacion_destino_fijo) || 0,
              otros_destino_descripcion: compra.otros_destino_descripcion,
              costo_otros_destino_valor: parseFloat(compra.costo_otros_destino_valor) || 0,
              base_calculo_peso: compra.base_calculo_peso || "BRUTO_CAMPO"
            },
            venta: {
              id: venta.id,
              numero: venta.numero_contrato,
              especie: venta.especie_nombre,
              id_especie: venta.id_especie,
              toneladas: parseFloat(venta.cantidad_toneladas_pactadas) || 0,
              asignadas: parseFloat(venta.cantidad_toneladas_asignadas) || 0,
              localidad_entrega: venta.localidad_entrega,
              costo_secada_punto: parseFloat(venta.costo_secada_punto) || 0,
              costo_zarandeo_tn: parseFloat(venta.costo_zarandeo_tn) || 0,
              costo_paritaria_tn: parseFloat(venta.costo_paritaria_tn) || 0,
              costo_fumigacion_fijo: parseFloat(venta.costo_fumigacion_fijo) || 0,
              humedad_max_seco: parseFloat(venta.humedad_max_seco) || 13.5,
              otros_descripcion: venta.otros_descripcion,
              costo_secada_destino_punto: parseFloat(venta.costo_secada_destino_punto) || 0,
              costo_zarandeo_destino_tn: parseFloat(venta.costo_zarandeo_destino_tn) || 0,
              costo_paritaria_destino_tn: parseFloat(venta.costo_paritaria_destino_tn) || 0,
              costo_fumigacion_destino_fijo: parseFloat(venta.costo_fumigacion_destino_fijo) || 0,
              otros_destino_descripcion: venta.otros_destino_descripcion,
              costo_otros_destino_valor: parseFloat(venta.costo_otros_destino_valor) || 0,
              base_calculo_peso: venta.base_calculo_peso || "BRUTO_CAMPO"
            }
          });
        }
      }
      return res.json(grouped);
    }

    let query = `
      SELECT c.*, cp.razon_social as contraparte_nombre, 
             e.nombre as especie_nombre, ca.descripcion as campana_desc
      FROM contratos c
      LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
      LEFT JOIN especies e ON c.id_especie = e.id
      LEFT JOIN campanas ca ON c.id_campana = ca.id
      WHERE c.activo = TRUE
    `;
    const params = [];
    if (modalidad) { params.push(modalidad); query += ` AND c.modalidad = $${params.length}`; }
    if (tipo) {
      params.push(tipo);
      query += ` AND c.tipo_contrato = $${params.length} AND c.es_canje = FALSE`;
    }
    if (estado) { params.push(estado); query += ` AND c.estado = $${params.length}`; }
    query += ' ORDER BY c.created_at DESC';

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET un contrato con sus movimientos
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, cp.razon_social as contraparte_nombre,
             e.nombre as especie_nombre, ca.descripcion as campana_desc
      FROM contratos c
      LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
      LEFT JOIN especies e ON c.id_especie = e.id
      LEFT JOIN campanas ca ON c.id_campana = ca.id
      WHERE c.id = $1
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });

    // Movimientos del contrato (incluyendo el relacionado si es canje)
    const contractIds = [req.params.id];
    if (rows[0].es_canje && rows[0].id_contrato_canje_relacionado) {
      contractIds.push(rows[0].id_contrato_canje_relacionado);
    }

    const { rows: movs } = await pool.query(`
      SELECT m.*, e.nombre as especie_nombre
      FROM movimientos m
      LEFT JOIN especies e ON m.id_especie = e.id
      WHERE m.id_contrato_compra = ANY($1) OR m.id_contrato_venta = ANY($1)
      ORDER BY m.created_at DESC
    `, [contractIds]);

    const { rows: fijaciones } = await pool.query(`
      SELECT id, TO_CHAR(fecha, 'YYYY-MM-DD') as fecha, cantidad_toneladas, precio_fijado, observaciones, created_at 
      FROM fijaciones_contrato 
      WHERE id_contrato = $1 
      ORDER BY fecha DESC, id DESC
    `, [req.params.id]);

    res.json({ ...rows[0], movimientos: movs, fijaciones });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST crear contrato
router.post('/', async (req, res) => {
  try {
    const {
      tipo_contrato, modalidad, tipo_liquidacion, fecha_contrato,
      fecha_entrega_desde, fecha_entrega_hasta, id_contraparte,
      id_especie, id_campana, cantidad_toneladas_pactadas,
      tipo_precio, moneda, precio_pactado, referencia_fijacion,
      diferencial_fijacion, tipo_diferencial, tipo_entrega,
      localidad_entrega, provincia_entrega, flete_estimado,
      forma_pago, plazo_pago_dias, condicion_pago,
      precio_venta_estimado, destino_venta_estimado, observaciones,
      costo_secada_punto, costo_zarandeo_tn, costo_paritaria_tn, costo_fumigacion_fijo,
      humedad_max_seco, otros_descripcion,
      costo_secada_destino_punto, costo_zarandeo_destino_tn, costo_paritaria_destino_tn,
      costo_fumigacion_destino_fijo, otros_destino_descripcion, costo_otros_destino_valor,
      base_calculo_peso
    } = req.body;

    // Generar número de contrato
    const prefix = tipo_contrato === 'COMPRA' ? 'OC' : tipo_contrato === 'VENTA' ? 'OV' : 'CA';
    const year = new Date().getFullYear();
    const { rows: last } = await pool.query(
      "SELECT numero_contrato FROM contratos WHERE numero_contrato LIKE $1 ORDER BY id DESC LIMIT 1",
      [`${prefix}-${year}-%`]
    );
    const num = last[0] ? parseInt(last[0].numero_contrato.split('-')[2]) + 1 : 1;
    const numero_contrato = `${prefix}-${year}-${String(num).padStart(4, '0')}`;

    const precioResuelto = resolverPrecioConDescuento(
      req.body.precio_referencia, req.body.descuento_precio_pct, precio_pactado
    );

    const { rows } = await pool.query(`
      INSERT INTO contratos (
        numero_contrato, tipo_contrato, modalidad, tipo_liquidacion,
        fecha_contrato, fecha_entrega_desde, fecha_entrega_hasta,
        id_contraparte, id_especie, id_campana, cantidad_toneladas_pactadas,
        tipo_precio, moneda, precio_pactado, referencia_fijacion,
        diferencial_fijacion, tipo_diferencial, tipo_entrega,
        localidad_entrega, provincia_entrega, flete_estimado,
        forma_pago, plazo_pago_dias, condicion_pago,
        precio_venta_estimado, destino_venta_estimado,
        localidad_entrega_pactada, comprador_estimado_id,
        aplica_cpe, costo_cpe_pct, costo_financiero_pct,
        costo_secada_punto, costo_zarandeo_tn, costo_paritaria_tn, costo_fumigacion_fijo,
        humedad_max_seco, otros_descripcion,
        costo_secada_destino_punto, costo_zarandeo_destino_tn, costo_paritaria_destino_tn,
        costo_fumigacion_destino_fijo, otros_destino_descripcion, costo_otros_destino_valor,
        observaciones, base_calculo_peso, precio_referencia, descuento_precio_pct, estado
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
        $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
        $28,$29,$30,$31,
        $32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,
        $44,$45,$46,$47,'CONFIRMADO'
      ) RETURNING *
    `, [numero_contrato, tipo_contrato, modalidad, tipo_liquidacion,
        fecha_contrato, fecha_entrega_desde||null, fecha_entrega_hasta||null,
        id_contraparte, id_especie, id_campana, cantidad_toneladas_pactadas,
        tipo_precio, moneda, precioResuelto.precio, referencia_fijacion||null,
        diferencial_fijacion||null, tipo_diferencial||null, tipo_entrega,
        localidad_entrega, provincia_entrega, flete_estimado||null,
        forma_pago, plazo_pago_dias||0, condicion_pago||'CONTADO',
        precio_venta_estimado||null, destino_venta_estimado,
        req.body.localidad_entrega_pactada||null,
        req.body.comprador_estimado_id||null,
        req.body.aplica_cpe||false,
        req.body.costo_cpe_pct||null,
        req.body.costo_financiero_pct||null,
        costo_secada_punto||0, costo_zarandeo_tn||0, costo_paritaria_tn||0, costo_fumigacion_fijo||0,
        humedad_max_seco||13.5, otros_descripcion||null,
        costo_secada_destino_punto||0, costo_zarandeo_destino_tn||0, costo_paritaria_destino_tn||0,
        costo_fumigacion_destino_fijo||0, otros_destino_descripcion||null, costo_otros_destino_valor||0,
        observaciones, base_calculo_peso||'BRUTO_CAMPO', precioResuelto.referencia, precioResuelto.descuento]);

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST crear contrato de canje (genera par compra/venta vinculado)
router.post('/canje', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      modalidad, id_contraparte, id_campana, observaciones,
      descripcion_relacion_canje,
      entrega, // { id_especie, toneladas, localidad_entrega, flete_estimado, ...costos } (VENTA)
      recepcion // { id_especie, toneladas, localidad_entrega, flete_estimado, ...costos } (COMPRA)
    } = req.body;

    const year = new Date().getFullYear();
    const fecha_contrato = req.body.fecha_contrato || new Date().toISOString().split('T')[0];

    // 1. Generar número para el lado de VENTA (CA-V-YYYY-XXXX)
    const { rows: lastV } = await client.query(
      "SELECT numero_contrato FROM contratos WHERE numero_contrato LIKE 'CA-V-%' ORDER BY id DESC LIMIT 1"
    );
    const numV = lastV[0] ? parseInt(lastV[0].numero_contrato.split('-')[3]) + 1 : 1;
    const nro_venta = `CA-V-${year}-${String(numV).padStart(4, '0')}`;

    // 2. Generar número para el lado de COMPRA (CA-C-YYYY-XXXX)
    const { rows: lastC } = await client.query(
      "SELECT numero_contrato FROM contratos WHERE numero_contrato LIKE 'CA-C-%' ORDER BY id DESC LIMIT 1"
    );
    const numC = lastC[0] ? parseInt(lastC[0].numero_contrato.split('-')[3]) + 1 : 1;
    const nro_compra = `CA-C-${year}-${String(numC).padStart(4, '0')}`;

    // 3. Insertar contrato de COMPRA (Lo que entra/recibimos)
    const resCompra = await client.query(`
      INSERT INTO contratos (
        numero_contrato, tipo_contrato, modalidad, fecha_contrato,
        id_contraparte, id_especie, id_campana, cantidad_toneladas_pactadas,
        tipo_precio, moneda, precio_pactado, tipo_entrega, localidad_entrega,
        costo_secada_punto, costo_zarandeo_tn, costo_paritaria_tn, costo_fumigacion_fijo,
        humedad_max_seco, otros_descripcion,
        costo_secada_destino_punto, costo_zarandeo_destino_tn, costo_paritaria_destino_tn,
        costo_fumigacion_destino_fijo, otros_destino_descripcion, costo_otros_destino_valor,
        es_canje, descripcion_relacion_canje, observaciones, estado
      ) VALUES (
        $1, 'COMPRA', $2, $3, $4, $5, $6, $7, 'PRECIO_HECHO', 'PESOS', 0, 'PUESTO_DESTINO', $8,
        $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, TRUE, $21, $22, 'CONFIRMADO'
      ) RETURNING id
    `, [
      nro_compra, modalidad, fecha_contrato, id_contraparte, recepcion.id_especie, id_campana, recepcion.toneladas, recepcion.localidad_entrega,
      recepcion.costo_secada_punto || 0, recepcion.costo_zarandeo_tn || 0, recepcion.costo_paritaria_tn || 0, recepcion.costo_fumigacion_fijo || 0,
      recepcion.humedad_max_seco || 13.5, recepcion.otros_descripcion || null,
      recepcion.costo_secada_destino_punto || 0, recepcion.costo_zarandeo_destino_tn || 0, recepcion.costo_paritaria_destino_tn || 0,
      recepcion.costo_fumigacion_destino_fijo || 0, recepcion.otros_destino_descripcion || null, recepcion.costo_otros_destino_valor || 0,
      descripcion_relacion_canje, observaciones || null
    ]);
    const idCompra = resCompra.rows[0].id;

    // 4. Insertar contrato de VENTA (Lo que sale/entregamos)
    const resVenta = await client.query(`
      INSERT INTO contratos (
        numero_contrato, tipo_contrato, modalidad, fecha_contrato,
        id_contraparte, id_especie, id_campana, cantidad_toneladas_pactadas,
        tipo_precio, moneda, precio_pactado, tipo_entrega, localidad_entrega,
        costo_secada_punto, costo_zarandeo_tn, costo_paritaria_tn, costo_fumigacion_fijo,
        humedad_max_seco, otros_descripcion,
        costo_secada_destino_punto, costo_zarandeo_destino_tn, costo_paritaria_destino_tn,
        costo_fumigacion_destino_fijo, otros_destino_descripcion, costo_otros_destino_valor,
        es_canje, descripcion_relacion_canje, observaciones, estado
      ) VALUES (
        $1, 'VENTA', $2, $3, $4, $5, $6, $7, 'PRECIO_HECHO', 'PESOS', 0, 'PUESTO_DESTINO', $8,
        $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, TRUE, $21, $22, 'CONFIRMADO'
      ) RETURNING id
    `, [
      nro_venta, modalidad, fecha_contrato, id_contraparte, entrega.id_especie, id_campana, entrega.toneladas, entrega.localidad_entrega,
      entrega.costo_secada_punto || 0, entrega.costo_zarandeo_tn || 0, entrega.costo_paritaria_tn || 0, entrega.costo_fumigacion_fijo || 0,
      entrega.humedad_max_seco || 13.5, entrega.otros_descripcion || null,
      entrega.costo_secada_destino_punto || 0, entrega.costo_zarandeo_destino_tn || 0, entrega.costo_paritaria_destino_tn || 0,
      entrega.costo_fumigacion_destino_fijo || 0, entrega.otros_destino_descripcion || null, entrega.costo_otros_destino_valor || 0,
      descripcion_relacion_canje, observaciones || null
    ]);
    const idVenta = resVenta.rows[0].id;

    // 5. Vincular mutuamente
    await client.query(
      "UPDATE contratos SET id_contrato_canje_relacionado = $1 WHERE id = $2",
      [idVenta, idCompra]
    );
    await client.query(
      "UPDATE contratos SET id_contrato_canje_relacionado = $1 WHERE id = $2",
      [idCompra, idVenta]
    );

    await client.query('COMMIT');
    res.status(201).json({ id_compra: idCompra, id_venta: idVenta });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PUT actualizar contrato de canje unificado
router.put('/canje/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;

    // Obtener contrato y su relación
    const { rows: current } = await client.query(
      "SELECT id, id_contrato_canje_relacionado, tipo_contrato FROM contratos WHERE id = $1 AND es_canje = TRUE",
      [id]
    );
    if (current.length === 0) {
      return res.status(404).json({ error: 'Contrato de canje no encontrado' });
    }

    const { id_contrato_canje_relacionado, tipo_contrato } = current[0];
    const idCompra = tipo_contrato === 'COMPRA' ? id : id_contrato_canje_relacionado;
    const idVenta = tipo_contrato === 'VENTA' ? id : id_contrato_canje_relacionado;

    // Validar si alguno tiene liquidaciones
    const { rows: liqs } = await client.query(
      'SELECT COUNT(*) as total FROM liquidaciones WHERE id_contrato IN ($1, $2)',
      [idCompra, idVenta]
    );
    if (parseInt(liqs[0].total) > 0) {
      return res.status(400).json({
        error: 'No se puede modificar el canje porque ya tiene liquidaciones asociadas en alguno de sus lados.'
      });
    }

    const {
      id_campana, observaciones, descripcion_relacion_canje,
      entrega, // { id_especie, toneladas, localidad_entrega, ... }
      recepcion // { id_especie, toneladas, localidad_entrega, ... }
    } = req.body;

    // Actualizar lado de COMPRA
    await client.query(`
      UPDATE contratos SET
        id_especie = $1,
        cantidad_toneladas_pactadas = $2,
        localidad_entrega = $3,
        costo_secada_punto = $4,
        costo_zarandeo_tn = $5,
        costo_paritaria_tn = $6,
        costo_fumigacion_fijo = $7,
        humedad_max_seco = $8,
        otros_descripcion = $9,
        costo_secada_destino_punto = $10,
        costo_zarandeo_destino_tn = $11,
        costo_paritaria_destino_tn = $12,
        costo_fumigacion_destino_fijo = $13,
        otros_destino_descripcion = $14,
        costo_otros_destino_valor = $15,
        descripcion_relacion_canje = $16,
        id_campana = $17,
        observaciones = $18,
        updated_at = NOW()
      WHERE id = $19
    `, [
      recepcion.id_especie, recepcion.toneladas, recepcion.localidad_entrega,
      recepcion.costo_secada_punto || 0, recepcion.costo_zarandeo_tn || 0, recepcion.costo_paritaria_tn || 0, recepcion.costo_fumigacion_fijo || 0,
      recepcion.humedad_max_seco || 13.5, recepcion.otros_descripcion || null,
      recepcion.costo_secada_destino_punto || 0, recepcion.costo_zarandeo_destino_tn || 0, recepcion.costo_paritaria_destino_tn || 0,
      recepcion.costo_fumigacion_destino_fijo || 0, recepcion.otros_destino_descripcion || null, recepcion.costo_otros_destino_valor || 0,
      descripcion_relacion_canje, id_campana, observaciones || null, idCompra
    ]);

    // Actualizar lado de VENTA
    await client.query(`
      UPDATE contratos SET
        id_especie = $1,
        cantidad_toneladas_pactadas = $2,
        localidad_entrega = $3,
        costo_secada_punto = $4,
        costo_zarandeo_tn = $5,
        costo_paritaria_tn = $6,
        costo_fumigacion_fijo = $7,
        humedad_max_seco = $8,
        otros_descripcion = $9,
        costo_secada_destino_punto = $10,
        costo_zarandeo_destino_tn = $11,
        costo_paritaria_destino_tn = $12,
        costo_fumigacion_destino_fijo = $13,
        otros_destino_descripcion = $14,
        costo_otros_destino_valor = $15,
        descripcion_relacion_canje = $16,
        id_campana = $17,
        observaciones = $18,
        updated_at = NOW()
      WHERE id = $19
    `, [
      entrega.id_especie, entrega.toneladas, entrega.localidad_entrega,
      entrega.costo_secada_punto || 0, entrega.costo_zarandeo_tn || 0, entrega.costo_paritaria_tn || 0, entrega.costo_fumigacion_fijo || 0,
      entrega.humedad_max_seco || 13.5, entrega.otros_descripcion || null,
      entrega.costo_secada_destino_punto || 0, entrega.costo_zarandeo_destino_tn || 0, entrega.costo_paritaria_destino_tn || 0,
      entrega.costo_fumigacion_destino_fijo || 0, entrega.otros_destino_descripcion || null, entrega.costo_otros_destino_valor || 0,
      descripcion_relacion_canje, id_campana, observaciones || null, idVenta
    ]);

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PUT actualizar estado
router.put('/:id/estado', async (req, res) => {
  try {
    const { estado } = req.body;
    const { rows } = await pool.query(
      'UPDATE contratos SET estado=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
      [estado, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT actualizar contrato (solo si no tiene liquidaciones)
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar si tiene liquidaciones asociadas
    const { rows: liqs } = await pool.query(
      'SELECT COUNT(*) as total FROM liquidaciones WHERE id_contrato = $1',
      [id]
    );
    if (parseInt(liqs[0].total) > 0) {
      return res.status(400).json({
        error: 'No se puede modificar el contrato porque ya tiene liquidaciones asociadas.'
      });
    }

    const {
      tipo_contrato, modalidad, tipo_liquidacion, fecha_contrato,
      fecha_entrega_desde, fecha_entrega_hasta, id_contraparte,
      id_especie, id_campana, cantidad_toneladas_pactadas,
      tipo_precio, moneda, precio_pactado, referencia_fijacion,
      diferencial_fijacion, tipo_diferencial, tipo_entrega,
      localidad_entrega, provincia_entrega, flete_estimado,
      forma_pago, plazo_pago_dias, condicion_pago,
      precio_venta_estimado, destino_venta_estimado, observaciones,
      aplica_cpe, costo_cpe_pct, costo_financiero_pct,
      comprador_estimado_id,
      costo_secada_punto, costo_zarandeo_tn, costo_paritaria_tn, costo_fumigacion_fijo,
      humedad_max_seco, otros_descripcion,
      costo_secada_destino_punto, costo_zarandeo_destino_tn, costo_paritaria_destino_tn,
      costo_fumigacion_destino_fijo, otros_destino_descripcion, costo_otros_destino_valor,
      base_calculo_peso
    } = req.body;

    const precioResuelto = resolverPrecioConDescuento(
      req.body.precio_referencia, req.body.descuento_precio_pct, precio_pactado
    );

    // Actualizar contrato
    const { rows } = await pool.query(`
      UPDATE contratos SET
        tipo_contrato = COALESCE($1, tipo_contrato),
        modalidad = COALESCE($2, modalidad),
        tipo_liquidacion = COALESCE($3, tipo_liquidacion),
        fecha_contrato = COALESCE($4, fecha_contrato),
        fecha_entrega_desde = $5,
        fecha_entrega_hasta = $6,
        id_contraparte = COALESCE($7, id_contraparte),
        id_especie = COALESCE($8, id_especie),
        id_campana = COALESCE($9, id_campana),
        cantidad_toneladas_pactadas = COALESCE($10, cantidad_toneladas_pactadas),
        tipo_precio = COALESCE($11, tipo_precio),
        moneda = COALESCE($12, moneda),
        precio_pactado = $13,
        referencia_fijacion = $14,
        diferencial_fijacion = $15,
        tipo_diferencial = $16,
        tipo_entrega = COALESCE($17, tipo_entrega),
        localidad_entrega = $18,
        provincia_entrega = $19,
        flete_estimado = $20,
        forma_pago = COALESCE($21, forma_pago),
        plazo_pago_dias = COALESCE($22, plazo_pago_dias),
        condicion_pago = COALESCE($23, condicion_pago),
        precio_venta_estimado = $24,
        destino_venta_estimado = $25,
        observaciones = $26,
        aplica_cpe = $27,
        costo_cpe_pct = $28,
        costo_financiero_pct = $29,
        comprador_estimado_id = $30,
        costo_secada_punto = $31,
        costo_zarandeo_tn = $32,
        costo_paritaria_tn = $33,
        costo_fumigacion_fijo = $34,
        humedad_max_seco = $35,
        otros_descripcion = $36,
        costo_secada_destino_punto = $37,
        costo_zarandeo_destino_tn = $38,
        costo_paritaria_destino_tn = $39,
        costo_fumigacion_destino_fijo = $40,
        otros_destino_descripcion = $41,
        costo_otros_destino_valor = $42,
        base_calculo_peso = COALESCE($43, base_calculo_peso),
        precio_referencia = $45,
        descuento_precio_pct = $46,
        updated_at = NOW()
      WHERE id = $44 RETURNING *
    `, [
      tipo_contrato, modalidad, tipo_liquidacion, fecha_contrato,
      fecha_entrega_desde, fecha_entrega_hasta, id_contraparte,
      id_especie, id_campana, cantidad_toneladas_pactadas,
      tipo_precio, moneda, precioResuelto.precio, referencia_fijacion,
      diferencial_fijacion, tipo_diferencial, tipo_entrega,
      localidad_entrega, provincia_entrega, flete_estimado,
      forma_pago, plazo_pago_dias, condicion_pago,
      precio_venta_estimado, destino_venta_estimado, observaciones,
      aplica_cpe, costo_cpe_pct, costo_financiero_pct,
      comprador_estimado_id,
      costo_secada_punto, costo_zarandeo_tn, costo_paritaria_tn, costo_fumigacion_fijo,
      humedad_max_seco, otros_descripcion,
      costo_secada_destino_punto, costo_zarandeo_destino_tn, costo_paritaria_destino_tn,
      costo_fumigacion_destino_fijo, otros_destino_descripcion, costo_otros_destino_valor,
      base_calculo_peso,
      id,
      precioResuelto.referencia, precioResuelto.descuento
    ]);

    if (!rows[0]) {
      return res.status(404).json({ error: 'Contrato no encontrado' });
    }

    // Recalcular contrato (para actualizar estado según pactadas vs asignadas)
    await recalcularContrato(id);

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE eliminar contrato (solo si no tiene movimientos asociados)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar si es contrato de canje y obtener el ID relacionado
    const { rows: contract } = await pool.query(
      "SELECT es_canje, id_contrato_canje_relacionado FROM contratos WHERE id = $1",
      [id]
    );
    if (!contract[0]) {
      return res.status(404).json({ error: 'Contrato no encontrado' });
    }

    const ids = [id];
    if (contract[0].es_canje && contract[0].id_contrato_canje_relacionado) {
      ids.push(contract[0].id_contrato_canje_relacionado);
    }

    // Verificar si tiene movimientos asociados en cualquiera de los lados vinculados
    const { rows: movs } = await pool.query(`
      SELECT COUNT(*) as total FROM movimientos
      WHERE id_contrato_compra = ANY($1) OR id_contrato_venta = ANY($1)
    `, [ids]);

    if (parseInt(movs[0].total) > 0) {
      return res.status(400).json({
        error: 'No se puede eliminar el contrato porque tiene camiones/movimientos asociados en alguno de sus lados.'
      });
    }

    // Soft delete de todos los IDs relacionados (par de canje o contrato individual)
    const { rows } = await pool.query(
      'UPDATE contratos SET activo = FALSE, updated_at = NOW() WHERE id = ANY($1) RETURNING *',
      [ids]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/contratos/:id/fijaciones
router.get('/:id/fijaciones', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      'SELECT id, id_contrato, TO_CHAR(fecha, \'YYYY-MM-DD\') as fecha, cantidad_toneladas, precio_fijado, precio_referencia, descuento_pct, observaciones, created_at FROM fijaciones_contrato WHERE id_contrato = $1 ORDER BY fecha DESC, id DESC',
      [id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contratos/:id/fijaciones
router.post('/:id/fijaciones', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { fecha, cantidad_toneladas, precio_fijado, precio_referencia, descuento_pct, observaciones } = req.body;

    if (!fecha || !cantidad_toneladas) {
      return res.status(400).json({ error: 'Faltan datos obligatorios (fecha, toneladas).' });
    }

    const precioResuelto = resolverPrecioConDescuento(precio_referencia, descuento_pct, precio_fijado);
    if (precioResuelto.precio === null || isNaN(precioResuelto.precio)) {
      return res.status(400).json({ error: 'Falta el precio: indicá el precio fijado, o una referencia con su descuento %.' });
    }

    // El total fijado no puede superar ni las toneladas pactadas del contrato
    // ni las toneladas efectivamente entregadas/asignadas hasta el momento.
    const { rows: contRows } = await client.query(
      'SELECT cantidad_toneladas_pactadas, cantidad_toneladas_asignadas FROM contratos WHERE id = $1',
      [id]
    );
    if (contRows.length === 0) {
      return res.status(404).json({ error: 'Contrato no encontrado.' });
    }
    const { rows: yaFijadoRows } = await client.query(
      'SELECT COALESCE(SUM(cantidad_toneladas), 0) as total FROM fijaciones_contrato WHERE id_contrato = $1',
      [id]
    );
    const yaFijado = parseFloat(yaFijadoRows[0].total);
    const pactadas = parseFloat(contRows[0].cantidad_toneladas_pactadas);
    const entregadas = parseFloat(contRows[0].cantidad_toneladas_asignadas) || 0;
    const tope = Math.min(pactadas, entregadas);
    const nuevoTotal = yaFijado + parseFloat(cantidad_toneladas);

    if (nuevoTotal > tope + 0.001) {
      return res.status(400).json({
        error: `No se puede fijar ${cantidad_toneladas} tn: superaría el tope de ${tope.toFixed(3)} tn (mínimo entre lo pactado: ${pactadas.toFixed(3)} tn y lo entregado: ${entregadas.toFixed(3)} tn). Ya fijado: ${yaFijado.toFixed(3)} tn, margen disponible: ${Math.max(0, tope - yaFijado).toFixed(3)} tn.`
      });
    }

    await client.query('BEGIN');

    // Insertar fijacion
    const { rows } = await client.query(
      `INSERT INTO fijaciones_contrato
        (id_contrato, fecha, cantidad_toneladas, precio_fijado, observaciones, precio_referencia, descuento_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, fecha, cantidad_toneladas, precioResuelto.precio, observaciones, precioResuelto.referencia, precioResuelto.descuento]
    );

    // Recalcular promedio ponderado y fecha de la ultima fijacion
    const { rows: sumRows } = await client.query(
      'SELECT COALESCE(SUM(cantidad_toneladas), 0) as total_fixed, COALESCE(SUM(cantidad_toneladas * precio_fijado), 0) as total_val, MAX(fecha) as last_date FROM fijaciones_contrato WHERE id_contrato = $1',
      [id]
    );
    const totalFixed = parseFloat(sumRows[0].total_fixed);
    const totalVal = parseFloat(sumRows[0].total_val);
    const lastDate = sumRows[0].last_date;

    const avgPrice = totalFixed > 0 ? (totalVal / totalFixed) : null;

    await client.query(
      'UPDATE contratos SET precio_fijado = $1, fecha_fijacion = $2, updated_at = NOW() WHERE id = $3',
      [avgPrice, lastDate, id]
    );

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/contratos/:id/fijaciones/:fijacionId
router.delete('/:id/fijaciones/:fijacionId', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id, fijacionId } = req.params;

    await client.query('BEGIN');

    await client.query(
      'DELETE FROM fijaciones_contrato WHERE id = $1 AND id_contrato = $2',
      [fijacionId, id]
    );

    // Recalcular promedio ponderado
    const { rows: sumRows } = await client.query(
      'SELECT COALESCE(SUM(cantidad_toneladas), 0) as total_fixed, COALESCE(SUM(cantidad_toneladas * precio_fijado), 0) as total_val, MAX(fecha) as last_date FROM fijaciones_contrato WHERE id_contrato = $1',
      [id]
    );
    const totalFixed = parseFloat(sumRows[0].total_fixed);
    const totalVal = parseFloat(sumRows[0].total_val);
    const lastDate = sumRows[0].last_date;

    const avgPrice = totalFixed > 0 ? (totalVal / totalFixed) : null;

    await client.query(
      'UPDATE contratos SET precio_fijado = $1, fecha_fijacion = $2, updated_at = NOW() WHERE id = $3',
      [avgPrice, lastDate, id]
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
