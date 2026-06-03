const router = require('express').Router();
const { pool } = require('../db');

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

    const { rows } = await pool.query(`
      UPDATE movimientos SET
        fecha_arribo=$1, fecha_descarga=$2, nro_turno=$3,
        peso_bruto_llegada_kg=$4, peso_tara_llegada_kg=$5,
        peso_neto_llegada_kg=$6, humedad_llegada_pct=$7,
        diferencia_kg=$8, tolerancia_kg=$9, faltante_kg=$10,
        estado='DESCARGADO', updated_at=NOW()
      WHERE id=$11 RETURNING *
    `, [fecha_arribo||null, fecha_descarga||null, nro_turno||null,
        peso_bruto_llegada_kg, peso_tara_llegada_kg, peso_neto_llegada,
        humedad_llegada_pct||null, diferencia, tolerancia, faltante,
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

    let factor_calculado = 1.0;

    if (parametros && parametros.length > 0) {
      for (const p of parametros) {
        const exceso = Math.max(0, p.valor_declarado - p.tolerancia);
        const ajuste = exceso > 0
          ? -(exceso * (p.descuento_por_punto || 0)) + (exceso * (p.bonificacion_por_punto || 0))
          : 0;
        factor_calculado += ajuste / 100;

        await pool.query(`
          INSERT INTO calidad_movimiento
            (id_movimiento, id_parametro, valor_declarado_pct, tolerancia_parametro_pct,
             exceso_sobre_tolerancia_pct, factor_descuento_bonificacion_pct)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [id, p.id_parametro, p.valor_declarado, p.tolerancia, exceso, ajuste]);
      }
    }

    const factor_aplicado = factor_manual || factor_calculado;

    // Obtener kg neto llegada
    const { rows: mov } = await pool.query('SELECT peso_neto_llegada_kg FROM movimientos WHERE id = $1', [id]);
    const kg_liquidables = mov[0].peso_neto_llegada_kg * factor_aplicado;

    const { rows } = await pool.query(`
      UPDATE movimientos SET
        factor_calculado=$1, factor_manual=$2, factor_aplicado=$3,
        tipo_factor=$4, kg_liquidables=$5, updated_at=NOW()
      WHERE id=$6 RETURNING *
    `, [factor_calculado, factor_manual||null, factor_aplicado,
        factor_manual ? 'MANUAL' : 'CALCULADO', kg_liquidables, id]);

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
