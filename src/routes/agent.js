const router = require('express').Router();
const { pool } = require('../db');

// helper function to query contracts tons and states
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
    const totalTn = parseFloat(sumRows[0].total_kg) / 1000;

    let nuevoEstado = 'BORRADOR';
    if (totalTn > 0) {
      if (totalTn >= parseFloat(cantidad_toneladas_pactadas)) {
        nuevoEstado = 'CUMPLIDO';
      } else {
        nuevoEstado = 'ACTIVO';
      }
    }

    await client.query(
      'UPDATE contratos SET cantidad_toneladas_asignadas = $1, estado = $2, updated_at = NOW() WHERE id = $3',
      [totalTn, nuevoEstado, id_contrato]
    );
  } finally {
    client.release();
  }
}

// GET all proposals
router.get('/proposals', async (req, res) => {
  try {
    const estado = req.query.estado || 'PENDIENTE';
    const { rows } = await pool.query(
      'SELECT * FROM propuestas_aprobacion WHERE estado = $1 ORDER BY id DESC',
      [estado]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST approve proposal
router.post('/proposals/:id/approve', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { usuario_aprobador } = req.body;
    if (!usuario_aprobador) {
      return res.status(400).json({ error: 'El usuario aprobador es obligatorio.' });
    }

    await client.query('BEGIN');

    // 1. Get proposal
    const { rows: pRows } = await client.query(
      'SELECT * FROM propuestas_aprobacion WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (pRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Propuesta no encontrada.' });
    }

    const prop = pRows[0];
    if (prop.estado !== 'PENDIENTE') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `La propuesta ya se encuentra en estado: ${prop.estado}.` });
    }

    const data = prop.datos_propuesta;

    // 2. Execute DB action based on tipo_accion
    let resultRecord = null;

    if (prop.tipo_accion === 'CREAR_CONTRAPARTE') {
      const { rows: checkCp } = await client.query('SELECT id FROM contrapartes WHERE cuit = $1 LIMIT 1', [data.cuit]);
      if (checkCp.length > 0) {
        throw new Error(`La contraparte con CUIT ${data.cuit} ya existe.`);
      }
      const { rows: cpIns } = await client.query(`
        INSERT INTO contrapartes (codigo_interno, razon_social, cuit, tipo_contraparte, canal_operacion)
        VALUES ($1, $2, $3, $4, $5) RETURNING *
      `, [data.codigo_interno, data.razon_social, data.cuit, data.tipo_contraparte, data.canal_operacion || 'AMBOS']);
      resultRecord = cpIns[0];

    } else if (prop.tipo_accion === 'CREAR_CONTRATO') {
      const { rows: checkCont } = await client.query('SELECT id FROM contratos WHERE numero_contrato = $1 LIMIT 1', [data.numero_contrato]);
      if (checkCont.length > 0) {
        throw new Error(`El contrato número ${data.numero_contrato} ya existe.`);
      }
      const { rows: contIns } = await client.query(`
        INSERT INTO contratos (numero_contrato, tipo_contrato, modalidad, id_contraparte, id_especie, id_campana, cantidad_toneladas_pactadas, tipo_precio, precio_pactado, moneda, fecha_contrato, estado)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_DATE, 'BORRADOR') RETURNING *
      `, [data.numero_contrato, data.tipo_contrato, data.modalidad, data.id_contraparte, data.id_especie, data.id_campana, data.cantidad_toneladas_pactadas, data.tipo_precio, data.precio_pactado || null, data.moneda]);
      resultRecord = contIns[0];

    } else if (prop.tipo_accion === 'ASIGNAR_CONTRATO_MOVIMIENTO') {
      const { id_movimiento, id_contrato_compra, id_contrato_venta } = data;
      
      const { rows: checkMov } = await client.query('SELECT * FROM movimientos WHERE id = $1', [id_movimiento]);
      if (checkMov.length === 0) {
        throw new Error(`Movimiento ID ${id_movimiento} no encontrado.`);
      }

      const estado_liquidacion = (id_contrato_compra || id_contrato_venta) ? 'ASIGNADO' : 'SIN_ASIGNAR';
      const { rows: movUpd } = await client.query(`
        UPDATE movimientos
        SET id_contrato_compra = COALESCE($1, id_contrato_compra),
            id_contrato_venta = COALESCE($2, id_contrato_venta),
            estado_liquidacion = $3,
            updated_at = NOW()
        WHERE id = $4 RETURNING *
      `, [id_contrato_compra || null, id_contrato_venta || null, estado_liquidacion, id_movimiento]);
      resultRecord = movUpd[0];

      // Recalculate contract tons
      if (id_contrato_compra) await recalcularContrato(id_contrato_compra);
      if (id_contrato_venta) await recalcularContrato(id_contrato_venta);

      // If linked movement exists, check if we need to sync
      const linkedId = checkMov[0].id_movimiento_vinculado;
      if (linkedId) {
        // Linked Formal does not get auto-assigned Informal's contracts directly because they differ in contracts (informal vs formal).
        // But we recalculate linked movement if applicable
        await recalcularContrato(linkedId);
      }

    } else if (prop.tipo_accion === 'CREAR_LIQUIDACION') {
      const { tipo, modalidad, tipo_liquidacion, id_contrato, id_contraparte, ids_movimientos, moneda, total_descuentos_servicios, observaciones } = data;

      // Verify not already liquidado
      const { rows: yaLiq } = await client.query(
        'SELECT id, numero_movimiento FROM movimientos WHERE id = ANY($1) AND estado_liquidacion = $2',
        [ids_movimientos, 'LIQUIDADO']
      );
      if (yaLiq.length > 0) {
        throw new Error(`Los siguientes movimientos ya están liquidados: ${yaLiq.map(m => m.numero_movimiento).join(', ')}`);
      }

      // Generate number
      const year = new Date().getFullYear();
      const { rows: last } = await client.query("SELECT nro_liquidacion FROM liquidaciones ORDER BY id DESC LIMIT 1");
      const num = last[0] ? parseInt(last[0].nro_liquidacion.split('-')[2]) + 1 : 1;
      const nro_liquidacion = `LIQ-${year}-${String(num).padStart(4, '0')}`;

      // Get movements
      const { rows: movs } = await client.query('SELECT * FROM movimientos WHERE id = ANY($1)', [ids_movimientos]);

      // Get contract price
      const { rows: contrato } = await client.query('SELECT * FROM contratos WHERE id = $1', [id_contrato]);
      const precio = contrato[0]?.precio_pactado || 0;

      let monto_bruto = 0;
      for (const m of movs) {
        monto_bruto += (m.kg_liquidables || 0) * precio / 1000;
      }

      let final_descuentos_servicios = 0;
      if (total_descuentos_servicios !== undefined) {
        final_descuentos_servicios = parseFloat(total_descuentos_servicios) || 0;
      } else {
        const { rows: servRows } = await client.query(
          'SELECT COALESCE(SUM(monto_real), 0) as total FROM servicios_movimiento WHERE id_movimiento = ANY($1) AND aplicado_a = $2',
          [ids_movimientos, tipo]
        );
        final_descuentos_servicios = parseFloat(servRows[0].total) || 0;
      }

      const monto_neto_a_pagar = monto_bruto - final_descuentos_servicios;

      const { rows: liqIns } = await client.query(`
        INSERT INTO liquidaciones
          (nro_liquidacion, tipo, modalidad, tipo_liquidacion, id_contrato,
           id_contraparte, fecha_liquidacion, monto_bruto_total,
           total_descuentos_servicios, total_retenciones, monto_neto_a_pagar,
           moneda, observaciones, estado)
        VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,0,$9,$10,$11,'EMITIDA')
        RETURNING *
      `, [nro_liquidacion, tipo, modalidad, tipo_liquidacion||null, id_contrato, id_contraparte, monto_bruto, final_descuentos_servicios, monto_neto_a_pagar, moneda||'PESOS', observaciones || null]);
      
      const createdLiq = liqIns[0];

      // Link movements
      for (const id_mov of ids_movimientos) {
        const mov = movs.find(m => m.id === id_mov);
        await client.query(`
          INSERT INTO liquidacion_movimientos
            (id_liquidacion, id_movimiento, kg_liquidables, factor_aplicado, precio_aplicado, moneda, monto_bruto_parcial)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [createdLiq.id, id_mov, mov.kg_liquidables, mov.factor_aplicado, precio, moneda||'PESOS', (mov.kg_liquidables || 0) * precio / 1000]);

        await client.query("UPDATE movimientos SET estado_liquidacion='LIQUIDADO', updated_at=NOW() WHERE id=$1", [id_mov]);
      }

      // CC entry
      const debeVal = tipo === 'COMPRA' ? 0 : monto_neto_a_pagar;
      const haberVal = tipo === 'COMPRA' ? monto_neto_a_pagar : 0;
      const saldoAcumulado = tipo === 'COMPRA' ? -monto_neto_a_pagar : monto_neto_a_pagar;

      await client.query(`
        INSERT INTO cc_contrapartes
          (id_contraparte, id_contrato, id_liquidacion, fecha, tipo_movimiento,
           concepto, debe, haber, saldo_acumulado, modalidad, estado)
        VALUES ($1, $2, $3, CURRENT_DATE, 'LIQUIDACION', $4, $5, $6, $7, $8, 'ABIERTO')
      `, [id_contraparte, id_contrato, createdLiq.id, `Liquidación ${nro_liquidacion}`, debeVal, haberVal, saldoAcumulado, modalidad]);

      resultRecord = createdLiq;
    } else {
      throw new Error(`Tipo de acción no soportado: ${prop.tipo_accion}`);
    }

    // 3. Update proposal state
    await client.query(`
      UPDATE propuestas_aprobacion
      SET estado = 'APROBADO',
          usuario_aprobador = $1,
          fecha_aprobacion = NOW(),
          updated_at = NOW()
      WHERE id = $2
    `, [usuario_aprobador, id]);

    await client.query('COMMIT');
    res.json({ success: true, proposal_id: id, result: resultRecord });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST reject proposal
router.post('/proposals/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { usuario_aprobador } = req.body;
    const { rows } = await pool.query(`
      UPDATE propuestas_aprobacion
      SET estado = 'RECHAZADO',
          usuario_aprobador = $1,
          fecha_aprobacion = NOW(),
          updated_at = NOW()
      WHERE id = $2 AND estado = 'PENDIENTE' RETURNING *
    `, [usuario_aprobador || 'SYSTEM', id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Propuesta no encontrada o no pendiente.' });
    }

    res.json({ success: true, proposal: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST chat with Agent
router.post('/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ error: 'Mensaje es obligatorio.' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'La variable de entorno GEMINI_API_KEY no está configurada.' });
    }

    // Prepare system instructions and tools schema
    const systemInstruction = `Eres "Agente IA Granosys", un asistente experto en comercialización de granos y administración agrícola para la plataforma Granosys.
Tu objetivo es ayudar al usuario a gestionar contratos, movimientos de descarga de camiones, cuenta corriente de productores/compradores y liquidación de granos.

Tienes acceso completo de lectura a la base de datos a través de tus herramientas (Function Declarations).
Cada vez que el usuario te pida consultar información, DEBES usar la herramienta de consulta correspondiente.

CRÍTICO - CONTROL DE SEGURIDAD:
No puedes modificar la base de datos directamente. Cualquier acción de creación, actualización o asignación de datos DEBE proponerse llamando a la herramienta 'propose_...' correspondiente.
Al llamar a una herramienta de propuesta, esta se guardará en la tabla de aprobación del sistema. Explícale al usuario por qué has generado la propuesta y pídele que la revise y apruebe en su bandeja de propuestas.

Responde de forma concisa, clara, estructurada y en español.`;

    const functionDeclarations = [
      {
        name: "get_contratos",
        description: "Obtener la lista de todos los contratos registrados en el sistema, con sus cantidades pactadas y asignadas, contraparte, moneda y estado.",
        parameters: { type: "OBJECT", properties: {} }
      },
      {
        name: "get_stock",
        description: "Obtener el stock de mercadería/granos en los distintos acopios, con detalle de especie, campaña y toneladas totales.",
        parameters: { type: "OBJECT", properties: {} }
      },
      {
        name: "get_movimientos",
        description: "Obtener la lista de los últimos 100 movimientos de granos (viajes/camiones), patentes, pesajes brutos/netos/tara, fechas y estado.",
        parameters: { type: "OBJECT", properties: {} }
      },
      {
        name: "get_cuenta_corriente",
        description: "Consultar las transacciones y saldos de las cuentas corrientes de los clientes, productores y transportistas.",
        parameters: { type: "OBJECT", properties: {} }
      },
      {
        name: "get_liquidaciones",
        description: "Obtener la lista de liquidaciones emitidas a productores y compradores con sus montos y estados.",
        parameters: { type: "OBJECT", properties: {} }
      },
      {
        name: "get_contrapartes",
        description: "Consultar el listado de contrapartes (productores, compradores, transportistas) registradas en el sistema.",
        parameters: { type: "OBJECT", properties: {} }
      },
      {
        name: "propose_crear_contraparte",
        description: "Generar una propuesta para dar de alta una nueva contraparte (productor o comprador) en el sistema. Requiere aprobación humana.",
        parameters: {
          type: "OBJECT",
          properties: {
            codigo_interno: { type: "STRING", description: "Código único de identificación interna" },
            razon_social: { type: "STRING", description: "Nombre o Razón Social de la contraparte" },
            cuit: { type: "STRING", description: "Número de CUIT (ej: 30-12345678-9)" },
            tipo_contraparte: { type: "STRING", enum: ["PRODUCTOR", "COMPRADOR", "AMBOS", "TRANSPORTISTA"], description: "Rol de la contraparte" },
            canal_operacion: { type: "STRING", enum: ["FORMAL", "INFORMAL", "AMBOS"], description: "Canal/modalidad en la que opera" },
            explicacion: { type: "STRING", description: "Justificación de por qué la IA propone esta creación" }
          },
          required: ["codigo_interno", "razon_social", "cuit", "tipo_contraparte", "explicacion"]
        }
      },
      {
        name: "propose_crear_contrato",
        description: "Generar una propuesta para registrar un nuevo contrato de compra o venta en el sistema. Requiere aprobación humana.",
        parameters: {
          type: "OBJECT",
          properties: {
            numero_contrato: { type: "STRING", description: "Número identificador único de contrato" },
            tipo_contrato: { type: "STRING", enum: ["COMPRA", "VENTA"] },
            modalidad: { type: "STRING", enum: ["FORMAL", "INFORMAL"] },
            id_contraparte: { type: "NUMBER", description: "ID numérico de la contraparte" },
            id_especie: { type: "NUMBER", description: "ID de la especie/grano (1=Soja, 2=Trigo, 3=Maíz, etc.)" },
            id_campana: { type: "NUMBER", description: "ID de la campaña (e.g. 2=2024/2025)" },
            cantidad_toneladas_pactadas: { type: "NUMBER", description: "Cantidad de toneladas del contrato" },
            tipo_precio: { type: "STRING", enum: ["FIJO", "A_FIJAR"] },
            precio_pactado: { type: "NUMBER", description: "Precio pactado por tonelada si es tipo FIJO" },
            moneda: { type: "STRING", enum: ["ARS", "USD"] },
            explicacion: { type: "STRING", description: "Justificación de la IA para proponer este contrato" }
          },
          required: ["numero_contrato", "tipo_contrato", "modalidad", "id_contraparte", "id_especie", "id_campana", "cantidad_toneladas_pactadas", "tipo_precio", "moneda", "explicacion"]
        }
      },
      {
        name: "propose_asignar_contrato_movimiento",
        description: "Generar una propuesta para asignar un viaje/movimiento de descarga a un contrato de compra o venta. Requiere aprobación humana.",
        parameters: {
          type: "OBJECT",
          properties: {
            id_movimiento: { type: "NUMBER", description: "ID numérico del viaje/movimiento a asignar" },
            id_contrato_compra: { type: "NUMBER", description: "ID del contrato de compra (opcional)" },
            id_contrato_venta: { type: "NUMBER", description: "ID del contrato de venta (opcional)" },
            explicacion: { type: "STRING", description: "Justificación del cruce de asignación propuesto" }
          },
          required: ["id_movimiento", "explicacion"]
        }
      },
      {
        name: "propose_crear_liquidacion",
        description: "Generar una propuesta para emitir una liquidación de granos a un productor o comprador para ciertos movimientos. Requiere aprobación humana.",
        parameters: {
          type: "OBJECT",
          properties: {
            tipo: { type: "STRING", enum: ["COMPRA", "VENTA"], description: "Tipo de liquidación" },
            modalidad: { type: "STRING", enum: ["FORMAL", "INFORMAL"] },
            id_contrato: { type: "NUMBER", description: "ID numérico del contrato de referencia" },
            id_contraparte: { type: "NUMBER", description: "ID numérico de la contraparte a liquidar" },
            ids_movimientos: {
              type: "ARRAY",
              items: { type: "NUMBER" },
              description: "Lista de IDs de movimientos a liquidar en esta boleta"
            },
            moneda: { type: "STRING", enum: ["PESOS", "DOLARES"], description: "Moneda de facturación" },
            total_descuentos_servicios: { type: "NUMBER", description: "Monto manual opcional de descuentos por servicios" },
            observaciones: { type: "STRING", description: "Observaciones de la liquidación" },
            explicacion: { type: "STRING", description: "Justificación de por qué la IA propone liquidar estos viajes ahora" }
          },
          required: ["tipo", "modalidad", "id_contrato", "id_contraparte", "ids_movimientos", "explicacion"]
        }
      }
    ];

    // Format chat history for Gemini API
    const formattedHistory = [];
    if (history && history.length > 0) {
      history.forEach(h => {
        formattedHistory.push({
          role: h.role === 'user' ? 'user' : 'model',
          parts: [{ text: h.text }]
        });
      });
    }

    formattedHistory.push({
      role: 'user',
      parts: [{ text: message }]
    });

    const requestBody = {
      contents: formattedHistory,
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      },
      tools: [{ functionDeclarations }]
    };

    // Call Gemini API via fetch (Node v18 native)
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: `Gemini API Error: ${errText}` });
    }

    const resJson = await response.json();
    const candidate = resJson.candidates?.[0];
    const part = candidate?.content?.parts?.[0];

    // Check if Gemini invoked a tool (Function Call)
    if (part?.functionCall) {
      const call = part.functionCall;
      const functionName = call.name;
      const args = call.args;

      let toolResult = null;
      let actionType = 'CONSULTA';
      let modulo = 'GENERAL';

      try {
        if (functionName === 'get_contratos') {
          const { rows } = await pool.query(`
            SELECT c.*, cp.razon_social as contraparte_nombre, e.nombre as especie_nombre, ca.descripcion as campana_desc 
            FROM contratos c 
            LEFT JOIN contrapartes cp ON c.id_contraparte = cp.id 
            LEFT JOIN especies e ON c.id_especie = e.id 
            LEFT JOIN campanas ca ON c.id_campana = ca.id 
            WHERE c.activo = true 
            ORDER BY c.fecha_contrato DESC LIMIT 100
          `);
          toolResult = rows;

        } else if (functionName === 'get_stock') {
          const { rows } = await pool.query(`
            SELECT s.*, e.nombre as especie_nombre, ca.descripcion as campana_desc, u.nombre as ubicacion_nombre 
            FROM stock s 
            LEFT JOIN especies e ON s.id_especie = e.id 
            LEFT JOIN campanas ca ON s.id_campana = ca.id 
            LEFT JOIN ubicaciones u ON s.id_ubicacion = u.id 
            WHERE s.toneladas_totales > 0
          `);
          toolResult = rows;

        } else if (functionName === 'get_movimientos') {
          const { rows } = await pool.query(`
            SELECT m.*, e.nombre as especie_nombre, ca.descripcion as campana_desc, 
                   c1.numero_contrato as contrato_compra_nro, c2.numero_contrato as contrato_venta_nro 
            FROM movimientos m 
            LEFT JOIN especies e ON m.id_especie = e.id 
            LEFT JOIN campanas ca ON m.id_campana = ca.id 
            LEFT JOIN contratos c1 ON m.id_contrato_compra = c1.id 
            LEFT JOIN contratos c2 ON m.id_contrato_venta = c2.id 
            ORDER BY m.id DESC LIMIT 100
          `);
          toolResult = rows;

        } else if (functionName === 'get_cuenta_corriente') {
          const { rows } = await pool.query(`
            SELECT cc.*, cp.razon_social as contraparte_nombre 
            FROM cc_contrapartes cc 
            LEFT JOIN contrapartes cp ON cc.id_contraparte = cp.id 
            ORDER BY cc.fecha DESC, cc.id DESC LIMIT 100
          `);
          toolResult = rows;

        } else if (functionName === 'get_liquidaciones') {
          const { rows } = await pool.query(`
            SELECT l.*, cp.razon_social as contraparte_nombre 
            FROM liquidaciones l 
            LEFT JOIN contrapartes cp ON l.id_contraparte = cp.id 
            ORDER BY l.id DESC LIMIT 100
          `);
          toolResult = rows;

        } else if (functionName === 'get_contrapartes') {
          const { rows } = await pool.query('SELECT * FROM contrapartes WHERE activo = true ORDER BY razon_social ASC');
          toolResult = rows;

        } else if (functionName === 'propose_crear_contraparte') {
          actionType = 'CREAR_CONTRAPARTE';
          modulo = 'CONTRAPARTES';
          const { rows } = await pool.query(`
            INSERT INTO propuestas_aprobacion (tipo_accion, modulo, datos_propuesta, explicacion, estado)
            VALUES ($1, $2, $3, $4, 'PENDIENTE') RETURNING *
          `, [actionType, modulo, JSON.stringify(args), args.explicacion || '']);
          toolResult = { status: 'PROPOSED', proposal: rows[0] };

        } else if (functionName === 'propose_crear_contrato') {
          actionType = 'CREAR_CONTRATO';
          modulo = 'CONTRATOS';
          const { rows } = await pool.query(`
            INSERT INTO propuestas_aprobacion (tipo_accion, modulo, datos_propuesta, explicacion, estado)
            VALUES ($1, $2, $3, $4, 'PENDIENTE') RETURNING *
          `, [actionType, modulo, JSON.stringify(args), args.explicacion || '']);
          toolResult = { status: 'PROPOSED', proposal: rows[0] };

        } else if (functionName === 'propose_asignar_contrato_movimiento') {
          actionType = 'ASIGNAR_CONTRATO_MOVIMIENTO';
          modulo = 'MOVIMIENTOS';
          const { rows } = await pool.query(`
            INSERT INTO propuestas_aprobacion (tipo_accion, modulo, datos_propuesta, explicacion, estado)
            VALUES ($1, $2, $3, $4, 'PENDIENTE') RETURNING *
          `, [actionType, modulo, JSON.stringify(args), args.explicacion || '']);
          toolResult = { status: 'PROPOSED', proposal: rows[0] };

        } else if (functionName === 'propose_crear_liquidacion') {
          actionType = 'CREAR_LIQUIDACION';
          modulo = 'LIQUIDACIONES';
          const { rows } = await pool.query(`
            INSERT INTO propuestas_aprobacion (tipo_accion, modulo, datos_propuesta, explicacion, estado)
            VALUES ($1, $2, $3, $4, 'PENDIENTE') RETURNING *
          `, [actionType, modulo, JSON.stringify(args), args.explicacion || '']);
          toolResult = { status: 'PROPOSED', proposal: rows[0] };

        } else {
          throw new Error(`Herramienta no implementada en backend: ${functionName}`);
        }
      } catch (dbErr) {
        toolResult = { error: dbErr.message };
      }

      // Feed the tool output back to Gemini
      const secondRequestBody = {
        contents: [
          ...formattedHistory,
          candidate.content,
          {
            role: 'user',
            parts: [{
              functionResponse: {
                name: functionName,
                response: { result: toolResult }
              }
            }]
          }
        ],
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        },
        tools: [{ functionDeclarations }]
      };

      const secondResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(secondRequestBody)
      });

      if (!secondResponse.ok) {
        const secondErrText = await secondResponse.text();
        return res.status(secondResponse.status).json({ error: `Gemini Tool Resolution Error: ${secondErrText}` });
      }

      const secondResJson = await secondResponse.json();
      const finalCandidate = secondResJson.candidates?.[0];
      const finalText = finalCandidate?.content?.parts?.[0]?.text || 'No pude procesar la respuesta.';

      return res.json({ text: finalText, proposal: (toolResult && toolResult.status === 'PROPOSED') ? toolResult.proposal : null });
    }

    // Normal text response
    const replyText = part?.text || 'No recibí respuesta.';
    res.json({ text: replyText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
