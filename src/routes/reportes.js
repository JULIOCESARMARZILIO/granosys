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
    const promptLower = rep.prompt.toLowerCase();

    // Comprobar si corresponde a contratos_resumen para devolver multitabla
    if ((promptLower.includes('contrato') || promptLower.includes('compra') || promptLower.includes('venta')) &&
        (promptLower.includes('compramos') || promptLower.includes('comprado') || promptLower.includes('faltan') || promptLower.includes('recibir') || promptLower.includes('resumen') || promptLower.includes('toneladas'))) {
      
      let modalidad = null;
      if (rep.sql_query.includes("c.modalidad = 'FORMAL'")) modalidad = 'FORMAL';
      if (rep.sql_query.includes("c.modalidad = 'INFORMAL'")) modalidad = 'INFORMAL';

      let startDate = null;
      let endDate = null;
      const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
      const mesIdx = meses.findIndex(m => promptLower.includes(m));
      const yearMatch = rep.prompt.match(/\b(20\d{2})\b/);
      const year = yearMatch ? parseInt(yearMatch[1]) : new Date().getFullYear();

      if (mesIdx !== -1) {
        startDate = `${year}-${String(mesIdx + 1).padStart(2, '0')}-01`;
        const lastDay = new Date(year, mesIdx + 1, 0).getDate();
        endDate = `${year}-${String(mesIdx + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      } else {
        const dateRegex = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/g;
        const dates = [];
        let match;
        while ((match = dateRegex.exec(rep.prompt)) !== null) {
          let day = match[1].padStart(2, '0');
          let month = match[2].padStart(2, '0');
          let y = match[3];
          if (y.length === 2) y = "20" + y;
          dates.push(`${y}-${month}-${day}`);
        }
        if (dates.length >= 2) {
          startDate = dates[0];
          endDate = dates[1];
        }
      }

      let whereSql = `c.tipo_contrato = 'COMPRA' AND c.activo = TRUE`;
      const queryParams = [];
      if (modalidad) {
        queryParams.push(modalidad);
        whereSql += ` AND c.modalidad = $${queryParams.length}`;
      }
      if (startDate) {
        queryParams.push(startDate);
        whereSql += ` AND c.fecha_contrato >= $${queryParams.length}`;
      }
      if (endDate) {
        queryParams.push(endDate);
        whereSql += ` AND c.fecha_contrato <= $${queryParams.length}`;
      }

      // Tabla 1
      const { rows: rowsCereal } = await pool.query(`
        SELECT e.nombre as "Cereal",
               SUM(c.cantidad_toneladas_pactadas) as "Comprado (Tn)",
               SUM(c.cantidad_toneladas_pactadas - c.cantidad_toneladas_asignadas) as "A recibir (Tn)"
        FROM contratos c
        LEFT JOIN especies e ON c.id_especie = e.id
        WHERE ${whereSql}
        GROUP BY e.nombre
        ORDER BY e.nombre
      `, queryParams);

      let totalComprado = 0;
      let totalARecibir = 0;
      rowsCereal.forEach(r => {
        totalComprado += parseFloat(r["Comprado (Tn)"] || 0);
        totalARecibir += parseFloat(r["A recibir (Tn)"] || 0);
        r["Comprado (Tn)"] = Math.round(parseFloat(r["Comprado (Tn)"] || 0) * 100) / 100;
        r["A recibir (Tn)"] = Math.round(parseFloat(r["A recibir (Tn)"] || 0) * 100) / 100;
      });
      rowsCereal.push({
        "Cereal": "Total",
        "Comprado (Tn)": Math.round(totalComprado * 100) / 100,
        "A recibir (Tn)": Math.round(totalARecibir * 100) / 100
      });

      // Tabla 2
      const { rows: rowsCliente } = await pool.query(`
        SELECT cp.razon_social as "Vendedor",
               e.nombre as "Cereal",
               SUM(c.cantidad_toneladas_pactadas) as "Comprado (Tn)",
               SUM(c.cantidad_toneladas_pactadas - c.cantidad_toneladas_asignadas) as "A recibir (Tn)"
        FROM contratos c
        LEFT JOIN especies e ON c.id_especie = e.id
        LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
        WHERE ${whereSql}
        GROUP BY cp.razon_social, e.nombre
        ORDER BY cp.razon_social, e.nombre
      `, queryParams);
      rowsCliente.forEach(r => {
        r["Comprado (Tn)"] = Math.round(parseFloat(r["Comprado (Tn)"] || 0) * 100) / 100;
        r["A recibir (Tn)"] = Math.round(parseFloat(r["A recibir (Tn)"] || 0) * 100) / 100;
      });

      // Tabla 3
      const { rows: rowsDetalle } = await pool.query(`
        SELECT c.numero_contrato as "Contrato",
               c.fecha_contrato::date as "Fecha",
               cp.razon_social as "Vendedor",
               e.nombre as "Cereal",
               c.cantidad_toneladas_pactadas as "Tn Pactadas",
               c.cantidad_toneladas_asignadas as "Tn Asignadas",
               (c.cantidad_toneladas_pactadas - c.cantidad_toneladas_asignadas) as "Tn Pendientes",
               c.estado as "Estado"
        FROM contratos c
        LEFT JOIN especies e ON c.id_especie = e.id
        LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
        WHERE ${whereSql}
        ORDER BY c.fecha_contrato DESC
      `, queryParams);
      rowsDetalle.forEach(r => {
        r["Tn Pactadas"] = Math.round(parseFloat(r["Tn Pactadas"] || 0) * 100) / 100;
        r["Tn Asignadas"] = Math.round(parseFloat(r["Tn Asignadas"] || 0) * 100) / 100;
        r["Tn Pendientes"] = Math.round(parseFloat(r["Tn Pendientes"] || 0) * 100) / 100;
      });

      return res.json({
        id: rep.id,
        titulo: rep.titulo,
        prompt: rep.prompt,
        sql_query: rep.sql_query,
        multitabla: true,
        tablas: [
          {
            titulo: "Resumen General de Compra",
            columnas: ["Cereal", "Comprado (Tn)", "A recibir (Tn)"],
            filas: rowsCereal
          },
          {
            titulo: "Desglose por Vendedor y Cereal",
            columnas: ["Vendedor", "Cereal", "Comprado (Tn)", "A recibir (Tn)"],
            filas: rowsCliente
          },
          {
            titulo: "Detalle de Contratos",
            columnas: ["Contrato", "Fecha", "Vendedor", "Cereal", "Tn Pactadas", "Tn Asignadas", "Tn Pendientes", "Estado"],
            filas: rowsDetalle
          }
        ]
      });
    }

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
    
    // 1. Detectar rango de fechas/meses
    let startDate = null;
    let endDate = null;
    const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const mesIdx = meses.findIndex(m => promptLower.includes(m));
    
    // Buscar años en el prompt, ej. 2024, 2025, 2026. Si no, usar año actual.
    const yearMatch = prompt.match(/\b(20\d{2})\b/);
    const year = yearMatch ? parseInt(yearMatch[1]) : new Date().getFullYear();

    if (mesIdx !== -1) {
      startDate = `${year}-${String(mesIdx + 1).padStart(2, '0')}-01`;
      const lastDay = new Date(year, mesIdx + 1, 0).getDate();
      endDate = `${year}-${String(mesIdx + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    } else {
      // Buscar rangos explicitados, ej: "entre 01/06/2026 y 15/06/2026"
      const dateRegex = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/g;
      const dates = [];
      let match;
      while ((match = dateRegex.exec(prompt)) !== null) {
        let day = match[1].padStart(2, '0');
        let month = match[2].padStart(2, '0');
        let y = match[3];
        if (y.length === 2) y = "20" + y;
        dates.push(`${y}-${month}-${day}`);
      }
      if (dates.length >= 2) {
        startDate = dates[0];
        endDate = dates[1];
      } else if (dates.length === 1) {
        if (promptLower.includes('desde') || promptLower.includes('después')) {
          startDate = dates[0];
        } else if (promptLower.includes('hasta') || promptLower.includes('antes')) {
          endDate = dates[0];
        }
      }
    }

    // 2. Determinar tipo de consulta
    let queryType = 'movimientos';

    if ((promptLower.includes('contrato') || promptLower.includes('compra') || promptLower.includes('venta')) &&
        (promptLower.includes('compramos') || promptLower.includes('comprado') || promptLower.includes('faltan') || promptLower.includes('recibir') || promptLower.includes('resumen') || promptLower.includes('toneladas'))) {
      queryType = 'contratos_resumen';
    } else if (promptLower.includes('contrato') || promptLower.includes('compra') || promptLower.includes('venta')) {
      queryType = 'contratos';
    } else if (promptLower.includes('contraparte') || promptLower.includes('productor') || promptLower.includes('comprador') || promptLower.includes('cliente') || promptLower.includes('proveedor')) {
      queryType = 'contrapartes';
    } else if (promptLower.includes('liquidacion') || promptLower.includes('liquidación')) {
      if (promptLower.includes('camion') || promptLower.includes('camión') || promptLower.includes('camiones') || promptLower.includes('movimiento') || promptLower.includes('movimientos') || promptLower.includes('viaje') || promptLower.includes('viajes') || promptLower.includes('patente')) {
        queryType = 'liquidaciones_desglose';
      } else {
        queryType = 'liquidaciones';
      }
    }

    let whereClauses = [];
    let params = [];

    // Filtro por modalidad
    if (modalidad) {
      params.push(modalidad);
      if (queryType === 'movimientos') {
        whereClauses.push(`m.modalidad = $${params.length}`);
      } else if (queryType === 'contratos' || queryType === 'contratos_resumen') {
        whereClauses.push(`c.modalidad = $${params.length}`);
      } else if (queryType === 'liquidaciones' || queryType === 'liquidaciones_desglose') {
        whereClauses.push(`l.modalidad = $${params.length}`);
      } else if (queryType === 'contrapartes') {
        whereClauses.push(`(canal_operacion = $${params.length} OR canal_operacion = 'AMBOS')`);
      }
    }

    // 3. Ejecutar Lógica por tipo de Consulta
    if (queryType === 'contratos_resumen') {
      let whereSql = `c.tipo_contrato = 'COMPRA' AND c.activo = TRUE`;
      const queryParams = [...params];
      
      if (modalidad) {
        whereSql += ` AND c.modalidad = $1`;
      }
      
      if (startDate) {
        queryParams.push(startDate);
        whereSql += ` AND c.fecha_contrato >= $${queryParams.length}`;
      }
      if (endDate) {
        queryParams.push(endDate);
        whereSql += ` AND c.fecha_contrato <= $${queryParams.length}`;
      }

      // Tabla 1: Resumen por Cereal
      const sqlResumenCereal = `
        SELECT e.nombre as "Cereal",
               SUM(c.cantidad_toneladas_pactadas) as "Comprado (Tn)",
               SUM(c.cantidad_toneladas_pactadas - c.cantidad_toneladas_asignadas) as "A recibir (Tn)"
        FROM contratos c
        LEFT JOIN especies e ON c.id_especie = e.id
        WHERE ${whereSql}
        GROUP BY e.nombre
        ORDER BY e.nombre
      `;
      const { rows: rowsCereal } = await pool.query(sqlResumenCereal, queryParams);

      let totalComprado = 0;
      let totalARecibir = 0;
      rowsCereal.forEach(r => {
        totalComprado += parseFloat(r["Comprado (Tn)"] || 0);
        totalARecibir += parseFloat(r["A recibir (Tn)"] || 0);
        r["Comprado (Tn)"] = Math.round(parseFloat(r["Comprado (Tn)"] || 0) * 100) / 100;
        r["A recibir (Tn)"] = Math.round(parseFloat(r["A recibir (Tn)"] || 0) * 100) / 100;
      });
      rowsCereal.push({
        "Cereal": "Total",
        "Comprado (Tn)": Math.round(totalComprado * 100) / 100,
        "A recibir (Tn)": Math.round(totalARecibir * 100) / 100
      });

      // Tabla 2: Resumen por Cliente/Vendedor y Cereal
      const sqlResumenCliente = `
        SELECT cp.razon_social as "Vendedor",
               e.nombre as "Cereal",
               SUM(c.cantidad_toneladas_pactadas) as "Comprado (Tn)",
               SUM(c.cantidad_toneladas_pactadas - c.cantidad_toneladas_asignadas) as "A recibir (Tn)"
        FROM contratos c
        LEFT JOIN especies e ON c.id_especie = e.id
        LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
        WHERE ${whereSql}
        GROUP BY cp.razon_social, e.nombre
        ORDER BY cp.razon_social, e.nombre
      `;
      const { rows: rowsCliente } = await pool.query(sqlResumenCliente, queryParams);
      rowsCliente.forEach(r => {
        r["Comprado (Tn)"] = Math.round(parseFloat(r["Comprado (Tn)"] || 0) * 100) / 100;
        r["A recibir (Tn)"] = Math.round(parseFloat(r["A recibir (Tn)"] || 0) * 100) / 100;
      });

      // Tabla 3: Detalle de Contratos
      const sqlDetalle = `
        SELECT c.numero_contrato as "Contrato",
               c.fecha_contrato::date as "Fecha",
               cp.razon_social as "Vendedor",
               e.nombre as "Cereal",
               c.cantidad_toneladas_pactadas as "Tn Pactadas",
               c.cantidad_toneladas_asignadas as "Tn Asignadas",
               (c.cantidad_toneladas_pactadas - c.cantidad_toneladas_asignadas) as "Tn Pendientes",
               c.estado as "Estado"
        FROM contratos c
        LEFT JOIN especies e ON c.id_especie = e.id
        LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id
        WHERE ${whereSql}
        ORDER BY c.fecha_contrato DESC
      `;
      const { rows: rowsDetalle } = await pool.query(sqlDetalle, queryParams);
      rowsDetalle.forEach(r => {
        r["Tn Pactadas"] = Math.round(parseFloat(r["Tn Pactadas"] || 0) * 100) / 100;
        r["Tn Asignadas"] = Math.round(parseFloat(r["Tn Asignadas"] || 0) * 100) / 100;
        r["Tn Pendientes"] = Math.round(parseFloat(r["Tn Pendientes"] || 0) * 100) / 100;
      });

      return res.json({
        sql: sqlResumenCereal,
        multitabla: true,
        tablas: [
          {
            titulo: "Resumen General de Compra",
            columnas: ["Cereal", "Comprado (Tn)", "A recibir (Tn)"],
            filas: rowsCereal
          },
          {
            titulo: "Desglose por Vendedor y Cereal",
            columnas: ["Vendedor", "Cereal", "Comprado (Tn)", "A recibir (Tn)"],
            filas: rowsCliente
          },
          {
            titulo: "Detalle de Contratos",
            columnas: ["Contrato", "Fecha", "Vendedor", "Cereal", "Tn Pactadas", "Tn Asignadas", "Tn Pendientes", "Estado"],
            filas: rowsDetalle
          }
        ]
      });
    }

    let sql = '';
    let columns = [];

    if (queryType === 'movimientos') {
      columns = [
        'id', 'Nro Movimiento', 'Especie', 'Campaña', 'Productor', 'Comprador',
        'Neto Salida', 'Faltante', 'Kg Liquidables', 'Estado', 'Chofer', 'Transportista', 'Fecha Creación',
        'Humedad Salida', 'Humedad Llegada', 'Patente Chasis', 'Patente Acoplado',
        'Contrato Compra', 'Contrato Venta', 'Nro CPE', 'Nro CTG',
        'Km Recorridos', 'Tarifa CATAC', 'Tarifa Flete Real', 'Factura Flete', 'Nro Liquidación'
      ];
      
      sql = `
        SELECT m.id, m.numero_movimiento as "Nro Movimiento",
               e.nombre as "Especie", ca.descripcion as "Campaña",
               cc.razon_social as "Productor", cv.razon_social as "Comprador",
               m.peso_neto_salida_kg as "Neto Salida", m.faltante_kg as "Faltante",
               m.kg_liquidables as "Kg Liquidables", m.estado as "Estado",
               m.chofer_nombre as "Chofer", m.transportista_nombre as "Transportista",
               m.created_at::date as "Fecha Creación",
               m.humedad_salida_pct as "Humedad Salida", m.humedad_llegada_pct as "Humedad Llegada",
               m.patente_chasis as "Patente Chasis", m.patente_acoplado as "Patente Acoplado",
               c1.numero_contrato as "Contrato Compra", c2.numero_contrato as "Contrato Venta",
               m.nro_cpe as "Nro CPE", m.nro_ctg as "Nro CTG",
               m.km_a_recorrer as "Km Recorridos", m.tarifa_catac as "Tarifa CATAC",
               m.tarifa_flete_real as "Tarifa Flete Real", m.nro_factura_flete as "Factura Flete",
               l.nro_liquidacion as "Nro Liquidación"
        FROM movimientos m
        LEFT JOIN especies e ON m.id_especie = e.id
        LEFT JOIN campanas ca ON m.id_campana = ca.id
        LEFT JOIN contratos c1 ON m.id_contrato_compra = c1.id
        LEFT JOIN contratos c2 ON m.id_contrato_venta = c2.id
        LEFT JOIN contrapartes cc ON c1.id_contraparte = cc.id
        LEFT JOIN contrapartes cv ON c2.id_contraparte = cv.id
        LEFT JOIN liquidacion_movimientos lm ON m.id = lm.id_movimiento
        LEFT JOIN liquidaciones l ON lm.id_liquidacion = l.id
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

      // Analizar fechas
      if (startDate) {
        params.push(startDate);
        whereClauses.push(`m.created_at::date >= $${params.length}`);
      }
      if (endDate) {
        params.push(endDate);
        whereClauses.push(`m.created_at::date <= $${params.length}`);
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
               c.fecha_contrato::date as "Fecha", cp.razon_social as "Contraparte",
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

      if (startDate) {
        params.push(startDate);
        whereClauses.push(`c.fecha_contrato >= $${params.length}`);
      }
      if (endDate) {
        params.push(endDate);
        whereClauses.push(`c.fecha_contrato <= $${params.length}`);
      }

    } else if (queryType === 'contrapartes') {
      columns = ['id', 'Código', 'CUIT', 'Razón Social', 'Tipo', 'Provincia', 'Localidad', 'Activo'];
      sql = `
        SELECT id, codigo_interno as "Código", cuit as "CUIT",
               razon_social as "Razón Social", tipo_contraparte as "Tipo",
               provincia as "Provincia", localidad as "Localidad", activo as "Activo"
        FROM contrapartes
      `;
    } else if (queryType === 'liquidaciones_desglose') {
      columns = [
        'id', 'Nro Liquidación', 'Tipo', 'Fecha', 'Contraparte', 'Monto Bruto', 'Descuentos', 'Monto Neto', 'Estado',
        'Nro Movimiento', 'Patente Chasis', 'Especie', 'Kg Liquidables', 'Factor Aplicado', 'Precio Aplicado', 'Monto Bruto Movimiento'
      ];
      sql = `
        SELECT l.id, l.nro_liquidacion as "Nro Liquidación", l.tipo as "Tipo",
               l.fecha_liquidacion::date as "Fecha", cp.razon_social as "Contraparte",
               l.monto_bruto_total as "Monto Bruto", l.total_descuentos_servicios as "Descuentos",
               l.monto_neto_a_pagar as "Monto Neto", l.estado as "Estado",
               m.numero_movimiento as "Nro Movimiento", m.patente_chasis as "Patente Chasis",
               e.nombre as "Especie", lm.kg_liquidables as "Kg Liquidables",
               lm.factor_aplicado as "Factor Aplicado", lm.precio_aplicado as "Precio Aplicado",
               lm.monto_bruto_parcial as "Monto Bruto Movimiento"
        FROM liquidaciones l
        LEFT JOIN contrapartes cp ON l.id_contraparte = cp.id
        LEFT JOIN liquidacion_movimientos lm ON l.id = lm.id_liquidacion
        LEFT JOIN movimientos m ON lm.id_movimiento = m.id
        LEFT JOIN especies e ON m.id_especie = e.id
      `;

      if (startDate) {
        params.push(startDate);
        whereClauses.push(`l.fecha_liquidacion >= $${params.length}`);
      }
      if (endDate) {
        params.push(endDate);
        whereClauses.push(`l.fecha_liquidacion <= $${params.length}`);
      }

    } else if (queryType === 'liquidaciones') {
      columns = ['id', 'Nro Liquidación', 'Tipo', 'Fecha', 'Contraparte', 'Monto Bruto', 'Descuentos', 'Retenciones', 'Monto Neto', 'Estado', 'Observaciones'];
      sql = `
        SELECT l.id, l.nro_liquidacion as "Nro Liquidación", l.tipo as "Tipo",
               l.fecha_liquidacion::date as "Fecha", cp.razon_social as "Contraparte",
               l.monto_bruto_total as "Monto Bruto", l.total_descuentos_servicios as "Descuentos",
               l.total_retenciones as "Retenciones", l.monto_neto_a_pagar as "Monto Neto", 
               l.estado as "Estado", l.observaciones as "Observaciones"
        FROM liquidaciones l
        LEFT JOIN contrapartes cp ON l.id_contraparte = cp.id
      `;

      if (startDate) {
        params.push(startDate);
        whereClauses.push(`l.fecha_liquidacion >= $${params.length}`);
      }
      if (endDate) {
        params.push(endDate);
        whereClauses.push(`l.fecha_liquidacion <= $${params.length}`);
      }
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

// GET /financiero - Cuánto hay que pagar/cobrar, agrupado por período y por
// acreedor. Separa GRANOS (liquidaciones a contrapartes vía cc_contrapartes)
// de FLETES (pagos a transportistas vía cc_transportistas), porque son dos
// circuitos y dos tablas totalmente distintos en el esquema.
//
// Dos vistas distintas a propósito:
//   - por_periodo: movimientos de cta-cte FECHADOS dentro de [desde, hasta],
//     agrupados por día/semana/mes. Sirve para proyectar cuánta plata nueva
//     se compromete por período (planificación de caja hacia adelante).
//   - por_acreedor: saldo NETO ACUMULADO histórico (todo el tiempo, sin
//     filtro de fecha) de cada contraparte/transportista al que se le debe
//     plata ahora mismo. Ninguna de las dos tablas tiene fecha de
//     vencimiento ni un flag de "pagado", así que "cuánto le debo a Juan hoy"
//     solo puede calcularse como la suma histórica completa, no acotada al
//     rango del reporte. Ordenado de mayor a menor deuda para poder decidir
//     a quién adelantar o atrasar el pago.
router.get('/financiero', async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const agrupacion = req.query.agrupacion || 'dia';
    const unitMap = { dia: 'day', semana: 'week', mes: 'month' };
    const unit = unitMap[agrupacion];

    if (!unit) {
      return res.status(400).json({ error: "El parámetro agrupacion debe ser 'dia', 'semana' o 'mes'" });
    }
    if (!desde || !hasta) {
      return res.status(400).json({ error: 'Los parámetros desde y hasta (YYYY-MM-DD) son obligatorios' });
    }
    const formato = unit === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';

    // Granos: liquidaciones + pagos/cobros/adelantos a contrapartes, dentro del rango
    const { rows: granosPorPeriodo } = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC($3, cc.fecha), $4) as periodo,
        MIN(cc.fecha) as periodo_desde,
        COALESCE(SUM(cc.haber - cc.debe), 0) as granos_neto,
        COUNT(*) as cantidad_movimientos
      FROM cc_contrapartes cc
      WHERE cc.fecha BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY MIN(cc.fecha) ASC
    `, [desde, hasta, unit, formato]);

    // Fletes: pagos/facturas/ajustes a transportistas, dentro del rango
    const { rows: fletesPorPeriodo } = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC($3, cct.fecha), $4) as periodo,
        MIN(cct.fecha) as periodo_desde,
        COALESCE(SUM(cct.haber - cct.debe), 0) as fletes_neto,
        COUNT(*) as cantidad_movimientos
      FROM cc_transportistas cct
      WHERE cct.fecha BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY MIN(cct.fecha) ASC
    `, [desde, hasta, unit, formato]);

    // Merge de ambas series por período
    const periodos = new Map();
    for (const r of granosPorPeriodo) {
      periodos.set(r.periodo, {
        periodo: r.periodo,
        periodo_desde: r.periodo_desde,
        granos_neto: parseFloat(r.granos_neto),
        fletes_neto: 0,
        cantidad_movimientos: parseInt(r.cantidad_movimientos, 10),
      });
    }
    for (const r of fletesPorPeriodo) {
      const existente = periodos.get(r.periodo);
      if (existente) {
        existente.fletes_neto = parseFloat(r.fletes_neto);
        existente.cantidad_movimientos += parseInt(r.cantidad_movimientos, 10);
      } else {
        periodos.set(r.periodo, {
          periodo: r.periodo,
          periodo_desde: r.periodo_desde,
          granos_neto: 0,
          fletes_neto: parseFloat(r.fletes_neto),
          cantidad_movimientos: parseInt(r.cantidad_movimientos, 10),
        });
      }
    }
    const por_periodo = Array.from(periodos.values())
      .map(p => ({ ...p, total_neto: Math.round((p.granos_neto + p.fletes_neto) * 100) / 100 }))
      .sort((a, b) => new Date(a.periodo_desde) - new Date(b.periodo_desde));

    // Ranking de acreedores (saldo positivo = todavía se les debe), sin filtro de fecha
    const { rows: acreedoresGranos } = await pool.query(`
      SELECT cp.id as id_entidad, cp.razon_social as nombre, cp.tipo_contraparte,
             COALESCE(SUM(cc.haber - cc.debe), 0) as monto_adeudado,
             COUNT(*) as movimientos, MIN(cc.fecha) as fecha_mas_antigua
      FROM cc_contrapartes cc
      JOIN contrapartes cp ON cc.id_contraparte = cp.id
      GROUP BY cp.id, cp.razon_social, cp.tipo_contraparte
      HAVING COALESCE(SUM(cc.haber - cc.debe), 0) > 0
      ORDER BY monto_adeudado DESC
    `);

    const { rows: acreedoresFletes } = await pool.query(`
      SELECT t.id as id_entidad, t.razon_social as nombre,
             COALESCE(SUM(cct.haber - cct.debe), 0) as monto_adeudado,
             COUNT(*) as movimientos, MIN(cct.fecha) as fecha_mas_antigua
      FROM cc_transportistas cct
      JOIN transportistas t ON cct.id_transportista = t.id
      GROUP BY t.id, t.razon_social
      HAVING COALESCE(SUM(cct.haber - cct.debe), 0) > 0
      ORDER BY monto_adeudado DESC
    `);

    const hoy = Date.now();
    const diasPendiente = (fecha) => Math.floor((hoy - new Date(fecha).getTime()) / 86400000);

    const por_acreedor = [
      ...acreedoresGranos.map(r => ({
        categoria: 'GRANOS',
        id_entidad: r.id_entidad,
        nombre: r.nombre,
        tipo_contraparte: r.tipo_contraparte,
        monto_adeudado: Math.round(parseFloat(r.monto_adeudado) * 100) / 100,
        movimientos: parseInt(r.movimientos, 10),
        fecha_mas_antigua: r.fecha_mas_antigua,
        dias_pendiente: diasPendiente(r.fecha_mas_antigua),
      })),
      ...acreedoresFletes.map(r => ({
        categoria: 'FLETES',
        id_entidad: r.id_entidad,
        nombre: r.nombre,
        tipo_contraparte: null,
        monto_adeudado: Math.round(parseFloat(r.monto_adeudado) * 100) / 100,
        movimientos: parseInt(r.movimientos, 10),
        fecha_mas_antigua: r.fecha_mas_antigua,
        dias_pendiente: diasPendiente(r.fecha_mas_antigua),
      })),
    ].sort((a, b) => b.monto_adeudado - a.monto_adeudado);

    res.json({ agrupacion, desde, hasta, por_periodo, por_acreedor });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
