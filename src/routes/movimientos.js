const router = require('express').Router();
const { pool } = require('../db');

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
             c2.numero_contrato as nro_contrato_venta
      FROM movimientos m
      LEFT JOIN especies e ON m.id_especie = e.id
      LEFT JOIN campanas ca ON m.id_campana = ca.id
      LEFT JOIN contratos c1 ON m.id_contrato_compra = c1.id
      LEFT JOIN contratos c2 ON m.id_contrato_venta = c2.id
      LEFT JOIN contrapartes cc ON c1.id_contraparte = cc.id
      LEFT JOIN contrapartes cv ON c2.id_contraparte = cv.id
      WHERE 1=1
    `;
    const params = [];
    if (modalidad) { params.push(modalidad); query += ` AND m.modalidad = $${params.length}`; }
    if (estado) { params.push(estado); query += ` AND m.estado = $${params.length}`; }
    query += ' ORDER BY m.created_at DESC';

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
      SELECT m.*, e.nombre as especie_nombre, ca.descripcion as campana_desc
      FROM movimientos m
      LEFT JOIN especies e ON m.id_especie = e.id
      LEFT JOIN campanas ca ON m.id_campana = ca.id
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
      observaciones
    } = req.body;

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
        humedad_salida_pct, observaciones
      ) VALUES (
        $1,$2,'EN_TRANSITO','SIN_ASIGNAR',
        $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,
        $37,$38,$39,$40,$41,$42,$43
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
        humedad_salida_pct||null, observaciones||null]);

    // Actualizar toneladas asignadas en contrato de compra
    if (id_contrato_compra && peso_neto_salida) {
      await pool.query(`
        UPDATE contratos SET
          cantidad_toneladas_asignadas = cantidad_toneladas_asignadas + $1,
          estado = CASE WHEN cantidad_toneladas_asignadas + $1 >= cantidad_toneladas_pactadas THEN 'CUMPLIDO' ELSE 'EN_CURSO' END,
          updated_at = NOW()
        WHERE id = $2
      `, [peso_neto_salida / 1000, id_contrato_compra]);
    }

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

    const factor_calculado = 1.0 - (merma_humedad_pct / 100.0) + (descuento_calidad_pct / 100.0);
    const factor_manual = mov[0].factor_manual !== null && mov[0].factor_manual !== undefined ? parseFloat(mov[0].factor_manual) : null;
    
    // Si hay factor_manual, representa el factor de calidad directo en modo informal. 
    // Le descontamos la merma de humedad para obtener el factor_aplicado final.
    const factor_aplicado = factor_manual !== null 
      ? factor_manual - (merma_humedad_pct / 100.0)
      : factor_calculado;

    const kg_liquidables = peso_neto_llegada * factor_aplicado;

    const { rows } = await pool.query(`
      UPDATE movimientos SET
        fecha_arribo=$1, fecha_descarga=$2, nro_turno=$3,
        peso_bruto_llegada_kg=$4, peso_tara_llegada_kg=$5,
        peso_neto_llegada_kg=$6, humedad_llegada_pct=$7,
        diferencia_kg=$8, tolerancia_kg=$9, faltante_kg=$10,
        factor_calculado=$11, factor_aplicado=$12, kg_liquidables=$13,
        estado='DESCARGADO', updated_at=NOW()
      WHERE id=$14 RETURNING *
    `, [fecha_arribo||null, fecha_descarga||null, nro_turno||null,
        peso_bruto_llegada_kg, peso_tara_llegada_kg, peso_neto_llegada,
        humedad_llegada_pct||null, diferencia, tolerancia, faltante,
        factor_calculado, factor_aplicado, kg_liquidables,
        req.params.id]);

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT registrar calidad y calcular factor
router.put('/:id/calidad', async (req, res) => {
  try {
    const { parametros, factor_manual } = req.body;
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

    let factor_calculado = 1.0 - (merma_humedad_pct / 100.0);

    if (parametros && parametros.length > 0) {
      for (const p of parametros) {
        const exceso = Math.max(0, p.valor_declarado - p.tolerancia);
        const ajuste = exceso > 0
          ? -(excess = exceso * (p.descuento_por_punto || 0)) + (exceso * (p.bonificacion_por_punto || 0))
          : 0;
        // Corregir un posible typo de arriba, mantener ajuste limpio
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

    const factor_aplicado = factor_manual !== undefined && factor_manual !== null 
      ? parseFloat(factor_manual) - (merma_humedad_pct / 100.0) 
      : factor_calculado;
    const kg_liquidables = m.peso_neto_llegada_kg * factor_aplicado;

    const { rows } = await pool.query(`
      UPDATE movimientos SET
        factor_calculado=$1, factor_manual=$2, factor_aplicado=$3,
        tipo_factor=$4, kg_liquidables=$5, updated_at=NOW()
      WHERE id=$6 RETURNING *
    `, [factor_calculado, factor_manual||null, factor_aplicado,
        factor_manual !== undefined && factor_manual !== null ? 'MANUAL' : 'CALCULADO', kg_liquidables, id]);

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT asignar contrato
router.put('/:id/asignar', async (req, res) => {
  try {
    const { id_contrato_compra, id_contrato_venta } = req.body;
    const { rows } = await pool.query(`
      UPDATE movimientos SET
        id_contrato_compra=COALESCE($1, id_contrato_compra),
        id_contrato_venta=COALESCE($2, id_contrato_venta),
        estado_liquidacion='ASIGNADO', updated_at=NOW()
      WHERE id=$3 RETURNING *
    `, [id_contrato_compra||null, id_contrato_venta||null, req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
