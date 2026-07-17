const router = require('express').Router();
const { pool } = require('../db');

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

// Asegura que una contraparte exista por CUIT o Razón Social, y si no, la crea automáticamente.
async function asegurarContraparte(cuit, nombre, tipoDefault) {
  if (!cuit || !nombre) return null;
  
  let cuitFormateado = cuit.replace(/[^0-9]/g, '');
  if (cuitFormateado.length === 11) {
    cuitFormateado = `${cuitFormateado.slice(0, 2)}-${cuitFormateado.slice(2, 10)}-${cuitFormateado.slice(10)}`;
  }

  // Buscar si existe por CUIT o por nombre exacto
  const { rows } = await pool.query(
    'SELECT id FROM contrapartes WHERE cuit = $1 OR razon_social = $2',
    [cuitFormateado, nombre]
  );

  if (rows.length > 0) {
    return rows[0].id;
  }

  // Generar código interno secuencial para la contraparte
  const prefix = tipoDefault === 'COMPRADOR' ? 'C' : 'P';
  const { rows: last } = await pool.query(
    "SELECT codigo_interno FROM contrapartes WHERE codigo_interno LIKE $1 ORDER BY id DESC LIMIT 1",
    [`${prefix}-%`]
  );
  const num = last[0] ? parseInt(last[0].codigo_interno.split('-')[1]) + 1 : 1;
  const codigo_interno = `${prefix}-${String(num).padStart(4, '0')}`;

  const { rows: nueva } = await pool.query(`
    INSERT INTO contrapartes (
      codigo_interno, cuit, razon_social, tipo_contraparte,
      canal_operacion, condicion_iva, activo
    ) VALUES ($1, $2, $3, $4, 'AMBOS', 'RI', TRUE)
    RETURNING id
  `, [codigo_interno, cuitFormateado, nombre, tipoDefault]);

  return nueva[0].id;
}

// GET todos los movimientos
router.get('/', async (req, res) => {
  try {
    const { modalidad, estado } = req.query;
    let query = `
      SELECT m.*,
             e.nombre as especie_nombre,
             ca.descripcion as campana_desc,
             cc.razon_social as contrato_compra_contraparte,
             cv.razon_social as contrato_venta_contraparte,
             c1.numero_contrato as nro_contrato_compra,
             c2.numero_contrato as nro_contrato_venta,
             l.nro_liquidacion as nro_liquidacion,
             COALESCE((SELECT SUM(sm.monto_real) FROM servicios_movimiento sm WHERE sm.id_movimiento = m.id AND sm.aplicado_a = 'COMPRA'), 0) as total_servicios_compra,
             COALESCE((SELECT SUM(sm.monto_real) FROM servicios_movimiento sm WHERE sm.id_movimiento = m.id AND sm.aplicado_a = 'VENTA'), 0) as total_servicios_venta
      FROM movimientos m
      LEFT JOIN especies e ON m.id_especie = e.id
      LEFT JOIN campanas ca ON m.id_campana = ca.id
      LEFT JOIN contratos c1 ON m.id_contrato_compra = c1.id
      LEFT JOIN contratos c2 ON m.id_contrato_venta = c2.id
      LEFT JOIN contrapartes cc ON c1.id_contraparte = cc.id
      LEFT JOIN contrapartes cv ON c2.id_contraparte = cv.id
      LEFT JOIN liquidacion_movimientos lm ON m.id = lm.id_movimiento
      LEFT JOIN liquidaciones l ON lm.id_liquidacion = l.id
      WHERE 1=1
    `;
    const params = [];
    if (modalidad) { params.push(modalidad); query += ` AND m.modalidad = $${params.length}`; }
    if (estado) { params.push(estado); query += ` AND m.estado = $${params.length}`; }
    query += `
      ORDER BY CASE 
        WHEN m.estado = 'BORRADOR' THEN 1
        WHEN m.estado = 'EN_TRANSITO' THEN 2
        WHEN m.estado = 'DESCARGADO' THEN 3
        WHEN m.estado = 'LIQUIDADO' THEN 4
        ELSE 5
      END ASC, m.created_at DESC
    `;

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET todas las mermas por humedad
router.get('/mermas', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM mermas_humedad ORDER BY id_especie, humedad');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET un movimiento con calidad y servicios
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.*, e.nombre as especie_nombre, ca.descripcion as campana_desc, l.nro_liquidacion as nro_liquidacion
      FROM movimientos m
      LEFT JOIN especies e ON m.id_especie = e.id
      LEFT JOIN campanas ca ON m.id_campana = ca.id
      LEFT JOIN liquidacion_movimientos lm ON m.id = lm.id_movimiento
      LEFT JOIN liquidaciones l ON lm.id_liquidacion = l.id
      WHERE m.id = $1
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });

    const { rows: calidad } = await pool.query(
      'SELECT cm.*, pce.nombre_parametro FROM calidad_movimiento cm LEFT JOIN parametros_calidad_especie pce ON cm.id_parametro = pce.id WHERE cm.id_movimiento = $1',
      [req.params.id]
    );
    const { rows: servicios } = await pool.query(
      'SELECT * FROM servicios_movimiento WHERE id_movimiento = $1',
      [req.params.id]
    );

    res.json({ ...rows[0], calidad, servicios });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST crear movimiento
router.post('/', async (req, res) => {
  try {
    const {
      modalidad, id_contrato_compra, id_contrato_venta,
      nro_cpe, nro_ctg, fecha_cpe, fecha_vencimiento_cpe,
      titular_cpe_cuit, titular_cpe_nombre,
      remitente_comercial_productor_cuit, remitente_comercial_productor_nombre,
      rte_comercial_venta_primaria_cuit, rte_comercial_venta_primaria_nombre,
      destinatario_cuit, destinatario_nombre, destino_cuit, destino_nombre,
      flete_pagador_cuit, flete_pagador_nombre,
      id_especie, id_campana, declaracion_calidad,
      renspa, localidad_origen, provincia_origen, latitud, longitud, descripcion_campo,
      nro_planta_destino, localidad_destino, provincia_destino,
      patente_chasis, patente_acoplado, km_a_recorrer,
      tarifa_catac, tarifa_flete_real, tipo_tarifa,
      peso_bruto_salida_kg, peso_tara_salida_kg, humedad_salida_pct,
      observaciones, usuario_carga, chofer_nombre, transportista_nombre,
      chofer, transportista, nro_factura_flete, fecha_partida
    } = req.body;

    const finalChofer = chofer_nombre || chofer || null;
    const finalTransportista = transportista_nombre || transportista || null;

    // Dar de alta automáticamente los intervinientes de la CPE si no existen
    if (titular_cpe_cuit && titular_cpe_nombre) {
      await asegurarContraparte(titular_cpe_cuit, titular_cpe_nombre, 'PRODUCTOR');
    }
    if (remitente_comercial_productor_cuit && remitente_comercial_productor_nombre) {
      await asegurarContraparte(remitente_comercial_productor_cuit, remitente_comercial_productor_nombre, 'PRODUCTOR');
    }
    if (destinatario_cuit && destinatario_nombre) {
      await asegurarContraparte(destinatario_cuit, destinatario_nombre, 'COMPRADOR');
    }
    if (destino_cuit && destino_nombre) {
      await asegurarContraparte(destino_cuit, destino_nombre, 'COMPRADOR');
    }
    if (flete_pagador_cuit && flete_pagador_nombre) {
      await asegurarContraparte(flete_pagador_cuit, flete_pagador_nombre, 'COMPRADOR');
    }

    // Generar número de movimiento
    const { rows: last } = await pool.query(
      "SELECT numero_movimiento FROM movimientos ORDER BY id DESC LIMIT 1"
    );
    const num = last[0] ? parseInt(last[0].numero_movimiento.split('-')[1]) + 1 : 1;
    const numero_movimiento = `MOV-${String(num).padStart(4, '0')}`;

    // Calcular kg neto salida
    const peso_neto_salida = peso_bruto_salida_kg && peso_tara_salida_kg
      ? parseFloat(peso_bruto_salida_kg) - parseFloat(peso_tara_salida_kg)
      : null;

    const estado_liquidacion = (id_contrato_compra || id_contrato_venta) ? 'ASIGNADO' : 'SIN_ASIGNAR';

    const { rows } = await pool.query(`
      INSERT INTO movimientos (
        numero_movimiento, modalidad, estado, estado_liquidacion,
        id_contrato_compra, id_contrato_venta,
        nro_cpe, nro_ctg, fecha_cpe, fecha_vencimiento_cpe,
        titular_cpe_cuit, titular_cpe_nombre,
        remitente_comercial_productor_cuit, remitente_comercial_productor_nombre,
        rte_comercial_venta_primaria_cuit, rte_comercial_venta_primaria_nombre,
        destinatario_cuit, destinatario_nombre, destino_cuit, destino_nombre,
        flete_pagador_cuit, flete_pagador_nombre,
        id_especie, id_campana, declaracion_calidad,
        renspa, localidad_origen, provincia_origen, latitud, longitud, descripcion_campo,
        nro_planta_destino, localidad_destino, provincia_destino,
        patente_chasis, patente_acoplado, km_a_recorrer,
        tarifa_catac, tarifa_flete_real, tipo_tarifa,
        peso_bruto_salida_kg, peso_tara_salida_kg, peso_neto_salida_kg,
        humedad_salida_pct, observaciones, usuario_carga, chofer_nombre, transportista_nombre,
        nro_factura_flete, fecha_partida
      ) VALUES (
        $1,$2,'EN_TRANSITO',$49,
        $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,
        $37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48
      ) RETURNING *
    `, [numero_movimiento, modalidad,
        id_contrato_compra||null, id_contrato_venta||null,
        nro_cpe||null, nro_ctg||null, fecha_cpe||null, fecha_vencimiento_cpe||null,
        titular_cpe_cuit||null, titular_cpe_nombre||null,
        remitente_comercial_productor_cuit||null, remitente_comercial_productor_nombre||null,
        rte_comercial_venta_primaria_cuit||null, rte_comercial_venta_primaria_nombre||null,
        destinatario_cuit||null, destinatario_nombre||null,
        destino_cuit||null, destino_nombre||null,
        flete_pagador_cuit||null, flete_pagador_nombre||null,
        id_especie||null, id_campana||null, declaracion_calidad||'CONFORME',
        renspa||null, localidad_origen||null, provincia_origen||null,
        latitud||null, longitud||null, descripcion_campo||null,
        nro_planta_destino||null, localidad_destino||null, provincia_destino||null,
        patente_chasis||null, patente_acoplado||null, km_a_recorrer||null,
        tarifa_catac||null, tarifa_flete_real||null, tipo_tarifa||'LLENA',
        peso_bruto_salida_kg||null, peso_tara_salida_kg||null, peso_neto_salida,
        humedad_salida_pct||null, observaciones||null, usuario_carga||null, finalChofer, finalTransportista,
        nro_factura_flete||null, fecha_partida||null, estado_liquidacion]);

    // Recalcular toneladas y estado de contratos
    await recalcularContrato(id_contrato_compra);
    await recalcularContrato(id_contrato_venta);

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// PUT registrar llegada
router.put('/:id/llegada', async (req, res) => {
  try {
    const {
      fecha_arribo, fecha_descarga, nro_turno,
      peso_bruto_llegada_kg, peso_tara_llegada_kg, humedad_llegada_pct
    } = req.body;

    const peso_neto_llegada = parseFloat(peso_bruto_llegada_kg) - parseFloat(peso_tara_llegada_kg);

    // Obtener movimiento para calcular faltante
    const { rows: mov } = await pool.query('SELECT * FROM movimientos WHERE id = $1', [req.params.id]);
    if (!mov[0]) return res.status(404).json({ error: 'No encontrado' });

    const diferencia = mov[0].peso_neto_salida_kg - peso_neto_llegada;
    const tolerancia = mov[0].peso_neto_salida_kg * 0.0003; // 0.3‰
    const faltante = Math.max(0, diferencia - tolerancia);

    // Obtener la merma de humedad desde la base de datos
    let merma_humedad_pct = 0.0;
    if (humedad_llegada_pct && parseFloat(humedad_llegada_pct) > 0) {
      const hum_redondeada = Math.round(parseFloat(humedad_llegada_pct) * 10) / 10;
      const { rows: mermaRows } = await pool.query(
        'SELECT merma_porcentaje FROM mermas_humedad WHERE id_especie = $1 AND humedad = $2',
        [mov[0].id_especie, hum_redondeada]
      );
      if (mermaRows[0]) {
        merma_humedad_pct = parseFloat(mermaRows[0].merma_porcentaje);
      } else {
        // Fallback si la humedad excede el máximo de la tabla (25.0%)
        if (hum_redondeada > 25.0) {
          const { rows: maxMermaRows } = await pool.query(
            'SELECT merma_porcentaje FROM mermas_humedad WHERE id_especie = $1 AND humedad = 25.0',
            [mov[0].id_especie]
          );
          const maxMerma = maxMermaRows[0] ? parseFloat(maxMermaRows[0].merma_porcentaje) : 0.0;
          merma_humedad_pct = maxMerma + (hum_redondeada - 25.0) * 1.15;
        }
      }
    }

    // Consultar descuentos de calidad registrados
    const { rows: calidad } = await pool.query(
      'SELECT * FROM calidad_movimiento WHERE id_movimiento = $1',
      [req.params.id]
    );
    let descuento_calidad_pct = 0.0;
    if (calidad.length > 0) {
      for (const c of calidad) {
        descuento_calidad_pct += parseFloat(c.factor_descuento_bonificacion_pct || 0);
      }
    }

    const factor_calculado = 1.0 + (descuento_calidad_pct / 100.0);
    const kg_secos = peso_neto_llegada * (1.0 - (merma_humedad_pct / 100.0));

    const calidad_tipo_ajuste = mov[0].calidad_tipo_ajuste || 'FACTOR';
    const calidad_valor_ajuste = mov[0].calidad_valor_ajuste !== null ? parseFloat(mov[0].calidad_valor_ajuste) : null;

    let factor_aplicado = factor_calculado;
    let kg_liquidables = kg_secos;
    let db_factor_manual = null;

    if (calidad_valor_ajuste !== null) {
      if (calidad_tipo_ajuste === 'PORCENTAJE') {
        db_factor_manual = 1.0 - (calidad_valor_ajuste / 100.0);
        factor_aplicado = db_factor_manual;
        kg_liquidables = kg_secos * factor_aplicado;
      } else if (calidad_tipo_ajuste === 'KILOS') {
        kg_liquidables = Math.max(0, kg_secos - calidad_valor_ajuste);
        db_factor_manual = kg_secos > 0 ? kg_liquidables / kg_secos : 0;
        factor_aplicado = db_factor_manual;
      } else { // 'FACTOR'
        db_factor_manual = calidad_valor_ajuste;
        factor_aplicado = db_factor_manual;
        kg_liquidables = kg_secos * factor_aplicado;
      }
    } else if (mov[0].factor_manual !== null) {
      db_factor_manual = parseFloat(mov[0].factor_manual);
      factor_aplicado = db_factor_manual;
      kg_liquidables = kg_secos * factor_aplicado;
    }

    const { rows } = await pool.query(`
      UPDATE movimientos SET
        fecha_arribo=$1, fecha_descarga=$2, nro_turno=$3,
        peso_bruto_llegada_kg=$4, peso_tara_llegada_kg=$5,
        peso_neto_llegada_kg=$6, humedad_llegada_pct=$7,
        diferencia_kg=$8, tolerancia_kg=$9, faltante_kg=$10,
        factor_calculado=$11, factor_manual=$12, factor_aplicado=$13, kg_liquidables=$14,
        estado='DESCARGADO', updated_at=NOW()
      WHERE id=$15 RETURNING *
    `, [fecha_arribo||null, fecha_descarga||null, nro_turno||null,
        peso_bruto_llegada_kg, peso_tara_llegada_kg, peso_neto_llegada,
        humedad_llegada_pct||null, diferencia, tolerancia, faltante,
        factor_calculado, db_factor_manual, factor_aplicado, kg_liquidables,
        req.params.id]);
    
    if (rows[0]) {
      await recalcularContrato(rows[0].id_contrato_compra);
      await recalcularContrato(rows[0].id_contrato_venta);
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT registrar calidad y calcular factor
router.put('/:id/calidad', async (req, res) => {
  try {
    const { parametros, factor_manual, calidad_tipo_ajuste, calidad_valor_ajuste } = req.body;
    const id = req.params.id;

    // Borrar calidad anterior
    await pool.query('DELETE FROM calidad_movimiento WHERE id_movimiento = $1', [id]);

    // Obtener movimiento para ver especie y humedad
    const { rows: mov } = await pool.query('SELECT id_especie, humedad_llegada_pct, peso_neto_llegada_kg FROM movimientos WHERE id = $1', [id]);
    if (!mov[0]) return res.status(404).json({ error: 'No encontrado' });
    const m = mov[0];

    // Obtener la merma de humedad desde la base de datos
    let merma_humedad_pct = 0.0;
    if (m.humedad_llegada_pct && parseFloat(m.humedad_llegada_pct) > 0) {
      const hum_redondeada = Math.round(parseFloat(m.humedad_llegada_pct) * 10) / 10;
      const { rows: mermaRows } = await pool.query(
        'SELECT merma_porcentaje FROM mermas_humedad WHERE id_especie = $1 AND humedad = $2',
        [m.id_especie, hum_redondeada]
      );
      if (mermaRows[0]) {
        merma_humedad_pct = parseFloat(mermaRows[0].merma_porcentaje);
      } else {
        // Fallback si la humedad excede el máximo de la tabla (25.0%)
        if (hum_redondeada > 25.0) {
          const { rows: maxMermaRows } = await pool.query(
            'SELECT merma_porcentaje FROM mermas_humedad WHERE id_especie = $1 AND humedad = 25.0',
            [m.id_especie]
          );
          const maxMerma = maxMermaRows[0] ? parseFloat(maxMermaRows[0].merma_porcentaje) : 0.0;
          merma_humedad_pct = maxMerma + (hum_redondeada - 25.0) * 1.15;
        }
      }
    }

    let factor_calculado = 1.0;

    if (parametros && parametros.length > 0) {
      for (const p of parametros) {
        const exceso = Math.max(0, p.valor_declarado - p.tolerancia);
        const ajuste_limpio = exceso > 0
          ? -(exceso * (p.descuento_por_punto || 0)) + (exceso * (p.bonificacion_por_punto || 0))
          : 0;
        factor_calculado += ajuste_limpio / 100;

        await pool.query(`
          INSERT INTO calidad_movimiento
            (id_movimiento, id_parametro, valor_declarado_pct, tolerancia_parametro_pct,
             exceso_sobre_tolerancia_pct, factor_descuento_bonificacion_pct)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [id, p.id_parametro, p.valor_declarado, p.tolerancia, exceso, ajuste_limpio]);
      }
    }

    let final_factor_manual = null;
    let final_tipo_factor = 'CALCULADO';
    
    // Los kilos liquidables aplican la merma de humedad al peso y luego el factor de calidad
    const kg_secos = m.peso_neto_llegada_kg * (1.0 - (merma_humedad_pct / 100.0));
    let kg_liquidables = kg_secos;
    let factor_aplicado = factor_calculado;

    if (calidad_tipo_ajuste !== undefined && calidad_tipo_ajuste !== null) {
      final_tipo_factor = calidad_tipo_ajuste;
      const val = calidad_valor_ajuste !== null && calidad_valor_ajuste !== undefined ? parseFloat(calidad_valor_ajuste) : null;
      if (val !== null) {
        if (calidad_tipo_ajuste === 'PORCENTAJE') {
          final_factor_manual = 1.0 - (val / 100.0);
          factor_aplicado = final_factor_manual;
          kg_liquidables = kg_secos * factor_aplicado;
        } else if (calidad_tipo_ajuste === 'KILOS') {
          kg_liquidables = Math.max(0, kg_secos - val);
          final_factor_manual = kg_secos > 0 ? kg_liquidables / kg_secos : 0;
          factor_aplicado = final_factor_manual;
        } else { // 'FACTOR'
          final_factor_manual = val;
          factor_aplicado = final_factor_manual;
          kg_liquidables = kg_secos * factor_aplicado;
        }
      }
    } else if (factor_manual !== undefined && factor_manual !== null) {
      final_factor_manual = parseFloat(factor_manual);
      final_tipo_factor = 'MANUAL';
      factor_aplicado = final_factor_manual;
      kg_liquidables = kg_secos * factor_aplicado;
    }

    const { rows } = await pool.query(`
      UPDATE movimientos SET
        factor_calculado=$1, factor_manual=$2, factor_aplicado=$3,
        tipo_factor=$4, kg_liquidables=$5,
        calidad_tipo_ajuste=$6, calidad_valor_ajuste=$7,
        updated_at=NOW()
      WHERE id=$8 RETURNING *
    `, [factor_calculado, final_factor_manual, factor_aplicado,
        final_tipo_factor, kg_liquidables,
        calidad_tipo_ajuste || 'FACTOR',
        calidad_valor_ajuste !== undefined && calidad_valor_ajuste !== null ? parseFloat(calidad_valor_ajuste) : null,
        id]);
    
    if (rows[0]) {
      await recalcularContrato(rows[0].id_contrato_compra);
      await recalcularContrato(rows[0].id_contrato_venta);
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT actualizar movimiento completo (general/salida)
router.put('/:id', async (req, res) => {
  try {
    const {
      id_contrato_compra, id_contrato_venta,
      nro_cpe, nro_ctg, fecha_cpe, fecha_vencimiento_cpe,
      titular_cpe_cuit, titular_cpe_nombre,
      remitente_comercial_productor_cuit, remitente_comercial_productor_nombre,
      rte_comercial_venta_primaria_cuit, rte_comercial_venta_primaria_nombre,
      destinatario_cuit, destinatario_nombre, destino_cuit, destino_nombre,
      flete_pagador_cuit, flete_pagador_nombre,
      id_especie, id_campana, declaracion_calidad,
      renspa, localidad_origen, provincia_origen, latitud, longitud, descripcion_campo,
      nro_planta_destino, localidad_destino, provincia_destino,
      id_transportista, id_chofer,
      patente_chasis, patente_acoplado, km_a_recorrer,
      tarifa_catac, tarifa_flete_real, tipo_tarifa,
      peso_bruto_salida_kg, peso_tara_salida_kg, humedad_salida_pct,
      observaciones, chofer_nombre, transportista_nombre,
      chofer, transportista, nro_factura_flete, fecha_partida
    } = req.body;

    const finalChofer = chofer_nombre || chofer || null;
    const finalTransportista = transportista_nombre || transportista || null;

    // Obtener los datos actuales del movimiento para determinar si cambia de contrato y el estado de liquidación actual
    const { rows: currentMov } = await pool.query('SELECT estado_liquidacion, id_contrato_compra, id_contrato_venta FROM movimientos WHERE id = $1', [req.params.id]);
    if (!currentMov[0]) return res.status(404).json({ error: 'No encontrado' });

    const oldCompraId = currentMov[0].id_contrato_compra;
    const oldVentaId = currentMov[0].id_contrato_venta;

    let estado_liq = currentMov[0].estado_liquidacion;
    if (estado_liq !== 'LIQUIDADO') {
      estado_liq = (id_contrato_compra || id_contrato_venta) ? 'ASIGNADO' : 'SIN_ASIGNAR';
    }

    // Calcular kg neto salida
    const peso_neto_salida = peso_bruto_salida_kg && peso_tara_salida_kg
      ? parseFloat(peso_bruto_salida_kg) - parseFloat(peso_tara_salida_kg)
      : null;

    const { rows } = await pool.query(`
      UPDATE movimientos SET
        id_contrato_compra=$1, id_contrato_venta=$2,
        nro_cpe=$3, nro_ctg=$4, fecha_cpe=$5, fecha_vencimiento_cpe=$6,
        titular_cpe_cuit=$7, titular_cpe_nombre=$8,
        remitente_comercial_productor_cuit=$9, remitente_comercial_productor_nombre=$10,
        rte_comercial_venta_primaria_cuit=$11, rte_comercial_venta_primaria_nombre=$12,
        destinatario_cuit=$13, destinatario_nombre=$14, destino_cuit=$15, destino_nombre=$16,
        flete_pagador_cuit=$17, flete_pagador_nombre=$18,
        id_especie=$19, id_campana=$20, declaracion_calidad=$21,
        renspa=$22, localidad_origen=$23, provincia_origen=$24, latitud=$25, longitud=$26, descripcion_campo=$27,
        nro_planta_destino=$28, localidad_destino=$29, provincia_destino=$30,
        id_transportista=$31, id_chofer=$32,
        patente_chasis=$33, patente_acoplado=$34, km_a_recorrer=$35,
        tarifa_catac=$36, tarifa_flete_real=$37, tipo_tarifa=$38,
        peso_bruto_salida_kg=$39, peso_tara_salida_kg=$40, peso_neto_salida_kg=$41,
        humedad_salida_pct=$42, observaciones=$43, chofer_nombre=$44, transportista_nombre=$45,
        nro_factura_flete=$46, fecha_partida=$47, estado_liquidacion=$48, updated_at=NOW()
      WHERE id=$49 RETURNING *
    `, [
        id_contrato_compra||null, id_contrato_venta||null,
        nro_cpe||null, nro_ctg||null, fecha_cpe||null, fecha_vencimiento_cpe||null,
        titular_cpe_cuit||null, titular_cpe_nombre||null,
        remitente_comercial_productor_cuit||null, remitente_comercial_productor_nombre||null,
        rte_comercial_venta_primaria_cuit||null, rte_comercial_venta_primaria_nombre||null,
        destinatario_cuit||null, destinatario_nombre||null,
        destino_cuit||null, destino_nombre||null,
        flete_pagador_cuit||null, flete_pagador_nombre||null,
        id_especie||null, id_campana||null, declaracion_calidad||'CONFORME',
        renspa||null, localidad_origen||null, provincia_origen||null, latitud||null, longitud||null, descripcion_campo||null,
        nro_planta_destino||null, localidad_destino||null, provincia_destino||null,
        id_transportista||null, id_chofer||null,
        patente_chasis||null, patente_acoplado||null, km_a_recorrer||null,
        tarifa_catac||null, tarifa_flete_real||null, tipo_tarifa||'LLENA',
        peso_bruto_salida_kg||null, peso_tara_salida_kg||null, peso_neto_salida,
        humedad_salida_pct||null, observaciones||null, finalChofer, finalTransportista,
        nro_factura_flete||null, fecha_partida||null, estado_liq, req.params.id
    ]);

    // Recalcular toneladas y estado de contratos involucrados
    await recalcularContrato(oldCompraId);
    await recalcularContrato(oldVentaId);
    if (id_contrato_compra && id_contrato_compra !== oldCompraId) {
      await recalcularContrato(id_contrato_compra);
    }
    if (id_contrato_venta && id_contrato_venta !== oldVentaId) {
      await recalcularContrato(id_contrato_venta);
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT asignar contrato
router.put('/:id/asignar', async (req, res) => {
  try {
    const { id_contrato_compra, id_contrato_venta } = req.body;

    // Obtener los contratos anteriores
    const { rows: currentMov } = await pool.query('SELECT id_contrato_compra, id_contrato_venta FROM movimientos WHERE id = $1', [req.params.id]);
    if (!currentMov[0]) return res.status(404).json({ error: 'No encontrado' });

    const oldCompraId = currentMov[0].id_contrato_compra;
    const oldVentaId = currentMov[0].id_contrato_venta;
    
    // Permitir actualizar a null si se pasa explícitamente en el body
    const id_compra = id_contrato_compra !== undefined ? id_contrato_compra : null;
    const id_venta = id_contrato_venta !== undefined ? id_contrato_venta : null;
    const estado_liq = (id_compra === null && id_venta === null) ? 'SIN_ASIGNAR' : 'ASIGNADO';

    const { rows } = await pool.query(`
      UPDATE movimientos SET
        id_contrato_compra=$1,
        id_contrato_venta=$2,
        estado_liquidacion=$3,
        updated_at=NOW()
      WHERE id=$4 RETURNING *
    `, [id_compra, id_venta, estado_liq, req.params.id]);

    // Recalcular contratos viejos y nuevos
    await recalcularContrato(oldCompraId);
    await recalcularContrato(oldVentaId);
    if (id_compra && id_compra !== oldCompraId) {
      await recalcularContrato(id_compra);
    }
    if (id_venta && id_venta !== oldVentaId) {
      await recalcularContrato(id_venta);
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE eliminar movimiento (por ejemplo, si está duplicado)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verificar si el movimiento ya fue liquidado
    const { rows: liqs } = await pool.query('SELECT id FROM liquidacion_movimientos WHERE id_movimiento = $1', [id]);
    if (liqs.length > 0) {
      return res.status(400).json({ error: 'No se puede eliminar un movimiento que ya está liquidado' });
    }

    // Obtener contratos antes de borrar
    const { rows: mov } = await pool.query('SELECT id_contrato_compra, id_contrato_venta FROM movimientos WHERE id = $1', [id]);
    if (mov.length === 0) {
      return res.status(404).json({ error: 'Movimiento no encontrado' });
    }
    const oldCompraId = mov[0].id_contrato_compra;
    const oldVentaId = mov[0].id_contrato_venta;

    // Primero eliminar de calidad_movimiento
    await pool.query('DELETE FROM calidad_movimiento WHERE id_movimiento = $1', [id]);
    // Eliminar de servicios_movimiento
    await pool.query('DELETE FROM servicios_movimiento WHERE id_movimiento = $1', [id]);
    
    // Eliminar de movimientos
    const { rowCount } = await pool.query('DELETE FROM movimientos WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Movimiento no encontrado' });
    }
    
    // Recalcular contratos
    await recalcularContrato(oldCompraId);
    await recalcularContrato(oldVentaId);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /bulk-update - Actualización masiva de fletes
router.put('/bulk-update', async (req, res) => {
  try {
    const { ids, tarifa_flete_real, transportista_nombre, chofer_nombre } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'IDs de movimientos requeridos' });
    }

    const updates = [];
    const params = [];

    if (tarifa_flete_real !== undefined) {
      const parsedTarifa = (tarifa_flete_real === '' || tarifa_flete_real === null) ? null : parseFloat(tarifa_flete_real);
      params.push(parsedTarifa);
      updates.push(`tarifa_flete_real = $${params.length}`);
    }
    if (transportista_nombre !== undefined) {
      params.push(transportista_nombre === '' ? null : transportista_nombre);
      updates.push(`transportista_nombre = $${params.length}`);
    }
    if (chofer_nombre !== undefined) {
      params.push(chofer_nombre === '' ? null : chofer_nombre);
      updates.push(`chofer_nombre = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Ningún campo para actualizar provisto' });
    }

    params.push(ids);
    const query = `
      UPDATE movimientos
      SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = ANY($${params.length})
      RETURNING id
    `;

    const { rows } = await pool.query(query, params);
    res.json({ updated: rows.map(r => r.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /bulk-preliquidar - Preliquidar fletes seleccionados (Agrupa por transportista y genera código)
router.put('/bulk-preliquidar', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'IDs de movimientos requeridos' });
    }

    // 1. Obtener los movimientos con su transportista
    const { rows: movs } = await pool.query(
      'SELECT id, transportista_nombre FROM movimientos WHERE id = ANY($1)',
      [ids]
    );

    if (movs.length === 0) {
      return res.status(400).json({ error: 'No se encontraron movimientos válidos' });
    }

    // 2. Agrupar por transportista_nombre
    const grupos = {};
    for (const m of movs) {
      const carrier = m.transportista_nombre || 'SinTransportista';
      if (!grupos[carrier]) grupos[carrier] = [];
      grupos[carrier].push(m.id);
    }

    const resultados = [];

    // 3. Generar código único y actualizar para cada grupo
    for (const [carrierName, groupIds] of Object.entries(grupos)) {
      const cleanName = carrierName
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Eliminar acentos
        .replace(/[^a-zA-Z0-9]/g, "") // Solo alfanumérico
        .substring(0, 15) || 'Flete';

      // Consultar códigos existentes para este transportista
      const { rows: exist } = await pool.query(
        "SELECT DISTINCT codigo_preliquidacion FROM movimientos WHERE codigo_preliquidacion LIKE $1",
        [`${cleanName}-%`]
      );

      let nextNum = 1;
      if (exist.length > 0) {
        const numbers = exist.map(r => {
          const parts = r.codigo_preliquidacion.split('-');
          const lastPart = parts[parts.length - 1];
          const parsed = parseInt(lastPart);
          return isNaN(parsed) ? 0 : parsed;
        });
        nextNum = Math.max(...numbers) + 1;
      }

      const code = `${cleanName}-${String(nextNum).padStart(4, '0')}`;

      // Actualizar los movimientos de este grupo
      await pool.query(`
        UPDATE movimientos
        SET estado_flete = 'PRELIQUIDADO',
            codigo_preliquidacion = $1,
            updated_at = NOW()
        WHERE id = ANY($2)
      `, [code, groupIds]);

      resultados.push({ codigo: code, transportista: carrierName, cantidad: groupIds.length });
    }

    res.json({ success: true, resultados });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /preliquidaciones/resumen - Listar grupos de preliquidaciones
router.get('/preliquidaciones/resumen', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.codigo_preliquidacion,
             m.transportista_nombre,
             t.id as id_transportista,
             MIN(m.created_at) as fecha,
             COUNT(*) as cantidad_viajes,
             SUM(m.peso_neto_llegada_kg) as total_neto_llegada,
             SUM(COALESCE(m.tarifa_flete_real, 0) * COALESCE(m.peso_neto_llegada_kg, 0) / 1000) as total_monto,
             MAX(m.nro_factura_flete) as nro_factura_flete,
             MAX(m.estado_flete) as estado_liquidacion
      FROM movimientos m
      LEFT JOIN transportistas t ON m.id_transportista = t.id OR m.transportista_nombre = t.razon_social
      WHERE m.codigo_preliquidacion IS NOT NULL
      GROUP BY m.codigo_preliquidacion, m.transportista_nombre, t.id
      ORDER BY fecha DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /preliquidaciones/:codigo/facturar - Asignar factura a una preliquidación y pasar saldo a cc_transportistas
router.put('/preliquidaciones/:codigo/facturar', async (req, res) => {
  const client = await pool.connect();
  try {
    const { codigo } = req.params;
    const { nro_factura_flete } = req.body;

    if (!nro_factura_flete) {
      return res.status(400).json({ error: 'Número de factura es requerido' });
    }

    await client.query('BEGIN');

    // 1. Obtener los movimientos asociados a esta preliquidación
    const { rows: movs } = await client.query(`
      SELECT m.id, m.id_transportista, m.transportista_nombre, m.tarifa_flete_real, m.peso_neto_llegada_kg, m.modalidad, m.estado_liquidacion
      FROM movimientos m
      WHERE m.codigo_preliquidacion = $1
    `, [codigo]);

    if (movs.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Preliquidación no encontrada' });
    }

    // Verificar si ya fue facturada (para evitar duplicaciones)
    const yaFacturada = movs.some(m => m.estado_liquidacion === 'LIQUIDADO');
    if (yaFacturada) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Esta preliquidación ya tiene una factura asignada y fue liquidada' });
    }

    // 2. Calcular el total del monto del flete de todos los movimientos de esta preliquidación
    let totalMonto = 0;
    let id_transportista = null;
    let transportista_nombre = '';

    for (const m of movs) {
      const tarifa = m.tarifa_flete_real ? parseFloat(m.tarifa_flete_real) : 0;
      const neto = m.peso_neto_llegada_kg ? parseFloat(m.peso_neto_llegada_kg) : 0;
      totalMonto += (tarifa * neto) / 1000;
      if (m.id_transportista) id_transportista = m.id_transportista;
      if (m.transportista_nombre) transportista_nombre = m.transportista_nombre;
    }

    totalMonto = Math.round(totalMonto * 100) / 100; // redondear a 2 decimales

    // 3. Buscar el transportista en la tabla de transportistas por nombre si no tenemos id
    if (!id_transportista && transportista_nombre) {
      const { rows: tRows } = await client.query(
        'SELECT id FROM transportistas WHERE razon_social = $1 LIMIT 1',
        [transportista_nombre]
      );
      if (tRows[0]) {
        id_transportista = tRows[0].id;
      }
    }

    if (!id_transportista) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `No se pudo asociar un transportista registrado para la preliquidación ${codigo}. Registrá el transportista con Razón Social: ${transportista_nombre} primero.` });
    }

    // 4. Actualizar todos los movimientos de la preliquidación
    await client.query(`
      UPDATE movimientos
      SET nro_factura_flete = $1,
          estado_flete = 'LIQUIDADO',
          updated_at = NOW()
      WHERE codigo_preliquidacion = $2
    `, [nro_factura_flete, codigo]);

    // 5. Insertar en cc_transportistas (Haber = totalMonto, Debe = 0)
    const { rows: lastCc } = await client.query(
      'SELECT saldo_acumulado FROM cc_transportistas WHERE id_transportista = $1 ORDER BY fecha DESC, id DESC LIMIT 1',
      [id_transportista]
    );
    const lastSaldo = lastCc[0] ? parseFloat(lastCc[0].saldo_acumulado) : 0;
    const haber = totalMonto;
    const debe = 0;
    // Convención de cuenta corriente de proveedores: saldo = saldo_anterior + debe - haber.
    const saldo_acumulado = lastSaldo + (debe - haber);

    await client.query(`
      INSERT INTO cc_transportistas (id_transportista, fecha, concepto, descripcion, debe, haber, saldo_acumulado, estado)
      VALUES ($1, CURRENT_DATE, 'FACTURA', $2, $3, $4, $5, 'ABIERTO')
    `, [id_transportista, `Preliq ${codigo} - Factura ${nro_factura_flete}`, debe, haber, saldo_acumulado]);

    await client.query('COMMIT');
    res.json({ success: true, codigo, nro_factura_flete, total_monto: totalMonto });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
