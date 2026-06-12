const router = require('express').Router();
const { pool } = require('../db');

// Reporte de pendientes — el corazón del módulo
router.get('/pendientes', async (req, res) => {
  try {
    // 1. Movimientos en tránsito sin llegada
    const { rows: enTransito } = await pool.query(`
      SELECT m.numero_movimiento, m.modalidad, m.fecha_partida,
             m.localidad_origen, m.provincia_origen,
             m.localidad_destino, m.provincia_destino,
             m.peso_neto_salida_kg, e.nombre as especie,
             c.numero_contrato,
             EXTRACT(DAY FROM NOW() - m.created_at) as dias_desde_salida
      FROM movimientos m
      LEFT JOIN especies e ON m.id_especie = e.id
      LEFT JOIN contratos c ON m.id_contrato_compra = c.id
      WHERE m.estado = 'EN_TRANSITO'
      ORDER BY m.created_at ASC
    `);

    // 2. Movimientos descargados sin liquidar
    const { rows: sinLiquidar } = await pool.query(`
      SELECT m.numero_movimiento, m.modalidad, m.fecha_descarga,
             m.kg_liquidables, m.factor_aplicado,
             e.nombre as especie, c.numero_contrato,
             cp.razon_social as productor,
             EXTRACT(DAY FROM NOW() - m.fecha_descarga) as dias_desde_descarga
      FROM movimientos m
      LEFT JOIN especies e ON m.id_especie = e.id
      LEFT JOIN contratos c ON m.id_contrato_compra = c.id
      LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
      WHERE m.estado = 'DESCARGADO' AND m.estado_liquidacion != 'LIQUIDADO'
      ORDER BY m.fecha_descarga ASC
    `);

    // 3. Movimientos sin contrato asignado
    const { rows: sinContrato } = await pool.query(`
      SELECT m.numero_movimiento, m.modalidad, m.created_at,
             e.nombre as especie, m.peso_neto_salida_kg,
             m.localidad_origen
      FROM movimientos m
      LEFT JOIN especies e ON m.id_especie = e.id
      WHERE m.id_contrato_compra IS NULL
      ORDER BY m.created_at ASC
    `);

    // 4. Movimientos sin calidad registrada
    const { rows: sinCalidad } = await pool.query(`
      SELECT m.numero_movimiento, m.modalidad, e.nombre as especie,
             m.kg_liquidables, m.factor_aplicado
      FROM movimientos m
      LEFT JOIN especies e ON m.id_especie = e.id
      LEFT JOIN calidad_movimiento cm ON m.id = cm.id_movimiento
      WHERE m.estado = 'DESCARGADO' AND cm.id IS NULL
    `);

    // 5. Contratos con entrega vencida
    const { rows: contratosVencidos } = await pool.query(`
      SELECT c.numero_contrato, c.tipo_contrato, c.modalidad,
             c.fecha_entrega_hasta, c.cantidad_toneladas_pactadas,
             c.cantidad_toneladas_asignadas,
             c.cantidad_toneladas_pactadas - c.cantidad_toneladas_asignadas as tn_pendientes,
             cp.razon_social as contraparte, e.nombre as especie
      FROM contratos c
      LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
      LEFT JOIN especies e ON c.id_especie = e.id
      WHERE c.fecha_entrega_hasta < NOW()
        AND c.estado NOT IN ('CUMPLIDO', 'CANCELADO')
        AND c.activo = TRUE
      ORDER BY c.fecha_entrega_hasta ASC
    `);

    // 6. Contratos a fijar sin precio
    const { rows: aFijar } = await pool.query(`
      SELECT c.numero_contrato, c.tipo_contrato, c.modalidad,
             c.cantidad_toneladas_pactadas, c.referencia_fijacion,
             c.diferencial_fijacion, c.tipo_diferencial,
             cp.razon_social as contraparte, e.nombre as especie,
             ca.descripcion as campana,
             EXTRACT(DAY FROM NOW() - c.created_at) as dias_sin_precio
      FROM contratos c
      LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
      LEFT JOIN especies e ON c.id_especie = e.id
      LEFT JOIN campanas ca ON c.id_campana = ca.id
      WHERE c.tipo_precio = 'A_FIJAR' AND c.precio_fijado IS NULL
        AND c.estado NOT IN ('CANCELADO') AND c.activo = TRUE
      ORDER BY c.created_at ASC
    `);

    // 7. Liquidaciones emitidas sin pagar
    const { rows: sinPagar } = await pool.query(`
      SELECT l.nro_liquidacion, l.tipo, l.modalidad, l.fecha_liquidacion,
             l.monto_neto_a_pagar, l.moneda,
             cp.razon_social as contraparte,
             EXTRACT(DAY FROM NOW() - l.fecha_liquidacion) as dias_emitida
      FROM liquidaciones l
      LEFT JOIN contrapartes cp ON l.id_contraparte = cp.id
      WHERE l.estado = 'EMITIDA'
      ORDER BY l.fecha_liquidacion ASC
    `);

    res.json({
      en_transito: enTransito,
      sin_liquidar: sinLiquidar,
      sin_contrato: sinContrato,
      sin_calidad: sinCalidad,
      contratos_vencidos: contratosVencidos,
      a_fijar: aFijar,
      sin_pagar: sinPagar,
      resumen: {
        total_en_transito: enTransito.length,
        total_sin_liquidar: sinLiquidar.length,
        total_sin_contrato: sinContrato.length,
        total_sin_calidad: sinCalidad.length,
        total_contratos_vencidos: contratosVencidos.length,
        total_a_fijar: aFijar.length,
        total_sin_pagar: sinPagar.length,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reporte de márgenes por contrato
router.get('/margenes', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        c.numero_contrato, c.tipo_contrato, c.modalidad,
        e.nombre as especie, ca.descripcion as campana,
        cp.razon_social as contraparte,
        c.cantidad_toneladas_pactadas,
        c.precio_pactado, c.precio_venta_estimado,
        c.flete_estimado,
        (c.precio_venta_estimado - c.precio_pactado - COALESCE(c.flete_estimado,0)) as margen_estimado_tn,
        c.cantidad_toneladas_pactadas * (c.precio_venta_estimado - c.precio_pactado - COALESCE(c.flete_estimado,0)) as margen_estimado_total
      FROM contratos c
      LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
      LEFT JOIN especies e ON c.id_especie = e.id
      LEFT JOIN campanas ca ON c.id_campana = ca.id
      WHERE c.tipo_contrato = 'COMPRA'
        AND c.precio_venta_estimado IS NOT NULL
        AND c.activo = TRUE
      ORDER BY margen_estimado_total DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reporte de posición a fijar
router.get('/posicion-fijar', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.numero_contrato, c.tipo_contrato, c.modalidad,
             e.nombre as especie, ca.descripcion as campana,
             cp.razon_social as contraparte,
             c.cantidad_toneladas_pactadas as tn_totales,
             c.cantidad_toneladas_asignadas as tn_asignadas,
             c.referencia_fijacion, c.diferencial_fijacion, c.tipo_diferencial,
             EXTRACT(DAY FROM NOW() - c.created_at) as dias_abierto
      FROM contratos c
      LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
      LEFT JOIN especies e ON c.id_especie = e.id
      LEFT JOIN campanas ca ON c.id_campana = ca.id
      WHERE c.tipo_precio = 'A_FIJAR'
        AND c.precio_fijado IS NULL
        AND c.estado NOT IN ('CANCELADO')
        AND c.activo = TRUE
      ORDER BY dias_abierto DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET todos los reportes de IA guardados
router.get('/ia', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM reportes_ia ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST guardar un reporte de IA
router.post('/ia', async (req, res) => {
  try {
    const { titulo, prompt, sql_query, columnas } = req.body;
    if (!titulo || !prompt || !sql_query || !columnas) {
      return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }
    const { rows } = await pool.query(`
      INSERT INTO reportes_ia (titulo, prompt, sql_query, columnas)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [titulo, prompt, sql_query, columnas]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET ejecutar un reporte guardado por ID (trae datos actualizados)
router.get('/ia/:id', async (req, res) => {
  try {
    const { rows: rRows } = await pool.query('SELECT * FROM reportes_ia WHERE id = $1', [req.params.id]);
    if (!rRows[0]) return res.status(404).json({ error: 'Reporte no encontrado' });

    const rep = rRows[0];
    // Ejecutar la query guardada para traer datos actuales
    const { rows: dataRows } = await pool.query(rep.sql_query);
    res.json({
      id: rep.id,
      titulo: rep.titulo,
      prompt: rep.prompt,
      sql_query: rep.sql_query,
      columnas: rep.columnas,
      filas: dataRows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST generar reporte con IA (parser inteligente de lenguaje natural)
router.post('/generar-ia', async (req, res) => {
  try {
    const { prompt, modalidad } = req.body;
    if (!prompt) return res.status(400).json({ error: 'El prompt es obligatorio' });

    const promptLower = prompt.toLowerCase();
    let sql = '';
    let columns = [];
    let queryType = 'movimientos';

    if (promptLower.includes('contrato') || promptLower.includes('compra') || promptLower.includes('venta')) {
      queryType = 'contratos';
    } else if (promptLower.includes('contraparte') || promptLower.includes('productor') || promptLower.includes('comprador') || promptLower.includes('cliente') || promptLower.includes('proveedor')) {
      queryType = 'contrapartes';
    } else if (promptLower.includes('liquidacion') || promptLower.includes('liquidación')) {
      queryType = 'liquidaciones';
    }

    let whereClauses = [];
    let params = [];

    // Filtro por modalidad (Formal/Informal) si el contexto lo requiere
    if (modalidad) {
      params.push(modalidad);
      if (queryType === 'movimientos') {
        whereClauses.push(`m.modalidad = $${params.length}`);
      } else if (queryType === 'contratos') {
        whereClauses.push(`c.modalidad = $${params.length}`);
      } else if (queryType === 'liquidaciones') {
        whereClauses.push(`l.modalidad = $${params.length}`);
      } else if (queryType === 'contrapartes') {
        whereClauses.push(`(canal_operacion = $${params.length} OR canal_operacion = 'AMBOS')`);
      }
    }

    if (queryType === 'movimientos') {
      columns = [
        'id', 'Nro Movimiento', 'Especie', 'Campaña', 'Productor', 'Comprador',
        'Neto Salida', 'Faltante', 'Kg Liquidables', 'Estado', 'Chofer', 'Transportista', 'Fecha Creación'
      ];
      
      sql = `
        SELECT m.id, m.numero_movimiento as "Nro Movimiento",
               e.nombre as "Especie", ca.descripcion as "Campaña",
               cc.razon_social as "Productor", cv.razon_social as "Comprador",
               m.peso_neto_salida_kg as "Neto Salida", m.faltante_kg as "Faltante",
               m.kg_liquidables as "Kg Liquidables", m.estado as "Estado",
               m.chofer_nombre as "Chofer", m.transportista_nombre as "Transportista",
               m.created_at::date as "Fecha Creación"
        FROM movimientos m
        LEFT JOIN especies e ON m.id_especie = e.id
        LEFT JOIN campanas ca ON m.id_campana = ca.id
        LEFT JOIN contratos c1 ON m.id_contrato_compra = c1.id
        LEFT JOIN contratos c2 ON m.id_contrato_venta = c2.id
        LEFT JOIN contrapartes cc ON c1.id_contraparte = cc.id
        LEFT JOIN contrapartes cv ON c2.id_contraparte = cv.id
      `;

      // Analizar especies
      if (promptLower.includes('soja')) {
        whereClauses.push(`LOWER(e.nombre) = 'soja'`);
      } else if (promptLower.includes('maiz') || promptLower.includes('maíz')) {
        whereClauses.push(`LOWER(e.nombre) = 'maíz'`);
      } else if (promptLower.includes('trigo')) {
        whereClauses.push(`LOWER(e.nombre) = 'trigo'`);
      } else if (promptLower.includes('girasol')) {
        whereClauses.push(`LOWER(e.nombre) = 'girasol'`);
      }

      // Analizar estados
      if (promptLower.includes('transito') || promptLower.includes('tránsito')) {
        whereClauses.push(`m.estado = 'EN_TRANSITO'`);
      } else if (promptLower.includes('descargado')) {
        whereClauses.push(`m.estado = 'DESCARGADO'`);
      } else if (promptLower.includes('liquidado')) {
        whereClauses.push(`m.estado = 'LIQUIDADO'`);
      } else if (promptLower.includes('borrador')) {
        whereClauses.push(`m.estado = 'BORRADOR'`);
      }

      // Analizar campañas
      if (promptLower.includes('24/25') || promptLower.includes('2024/2025')) {
        whereClauses.push(`ca.descripcion = '2024/2025'`);
      } else if (promptLower.includes('23/24') || promptLower.includes('2023/2024')) {
        whereClauses.push(`ca.descripcion = '2023/2024'`);
      } else if (promptLower.includes('25/26') || promptLower.includes('2025/2026')) {
        whereClauses.push(`ca.descripcion = '2025/2026'`);
      }

      // Analizar patentes (p.ej. AA123BB o AAA123)
      const patenteMatch = prompt.match(/[a-z]{2}\d{3}[a-z]{2}/i) || prompt.match(/[a-z]{3}\d{3}/i);
      if (patenteMatch) {
        params.push(`%${patenteMatch[0]}%`);
        whereClauses.push(`(m.patente_chasis ILIKE $${params.length} OR m.patente_acoplado ILIKE $${params.length})`);
      }

      // Match dinámico de nombres de contrapartes
      const { rows: contrapartesDb } = await pool.query('SELECT id, razon_social FROM contrapartes WHERE activo = TRUE');
      for (const cp of contrapartesDb) {
        const parts = cp.razon_social.toLowerCase().split(' ').filter(p => p.length > 3);
        const matches = parts.some(p => promptLower.includes(p));
        if (matches) {
          whereClauses.push(`(cc.id = ${cp.id} OR cv.id = ${cp.id})`);
          break; // Con una coincidencia basta
        }
      }

    } else if (queryType === 'contratos') {
      columns = [
        'id', 'Nro Contrato', 'Tipo', 'Fecha', 'Contraparte', 'Especie',
        'Campaña', 'Tn Pactadas', 'Tn Asignadas', 'Precio', 'Moneda', 'Estado'
      ];
      
      sql = `
        SELECT c.id, c.numero_contrato as "Nro Contrato", c.tipo_contrato as "Tipo",
               c.fecha_contrato as "Fecha", cp.razon_social as "Contraparte",
               e.nombre as "Especie", ca.descripcion as "Campaña",
               c.cantidad_toneladas_pactadas as "Tn Pactadas",
               c.cantidad_toneladas_asignadas as "Tn Asignadas",
               c.precio_pactado as "Precio", c.moneda as "Moneda", c.estado as "Estado"
        FROM contratos c
        LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
        LEFT JOIN especies e ON c.id_especie = e.id
        LEFT JOIN campanas ca ON c.id_campana = ca.id
      `;

      if (promptLower.includes('compra')) {
        whereClauses.push(`c.tipo_contrato = 'COMPRA'`);
      } else if (promptLower.includes('venta')) {
        whereClauses.push(`c.tipo_contrato = 'VENTA'`);
      }

    } else if (queryType === 'contrapartes') {
      columns = ['id', 'Código', 'CUIT', 'Razón Social', 'Tipo', 'Provincia', 'Localidad', 'Activo'];
      sql = `
        SELECT id, codigo_interno as "Código", cuit as "CUIT",
               razon_social as "Razón Social", tipo_contraparte as "Tipo",
               provincia as "Provincia", localidad as "Localidad", activo as "Activo"
        FROM contrapartes
      `;
    } else if (queryType === 'liquidaciones') {
      columns = ['id', 'Nro Liquidación', 'Tipo', 'Fecha', 'Contraparte', 'Monto Bruto', 'Descuentos', 'Monto Neto', 'Estado'];
      sql = `
        SELECT l.id, l.nro_liquidacion as "Nro Liquidación", l.tipo as "Tipo",
               l.fecha_liquidacion as "Fecha", cp.razon_social as "Contraparte",
               l.monto_bruto_total as "Monto Bruto", l.total_descuentos_servicios as "Descuentos",
               l.monto_neto_a_pagar as "Monto Neto", l.estado as "Estado"
        FROM liquidaciones l
        LEFT JOIN contrapartes cp ON l.id_contraparte = cp.id
      `;
    }

    if (whereClauses.length > 0) {
      sql += ' WHERE ' + whereClauses.join(' AND ');
    }

    sql += ' ORDER BY 1 DESC LIMIT 100';

    const { rows } = await pool.query(sql, params);
    res.json({ sql, columnas: columns, filas: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
