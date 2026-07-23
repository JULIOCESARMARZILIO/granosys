const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  const client = await pool.connect();
  try {
    console.log('Conectando a PostgreSQL...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS campanas (
        id SERIAL PRIMARY KEY,
        descripcion VARCHAR(20) NOT NULL,
        anio_inicio INTEGER NOT NULL,
        anio_fin INTEGER NOT NULL,
        activa BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS especies (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(50) NOT NULL,
        codigo VARCHAR(10) NOT NULL UNIQUE,
        activa BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS parametros_calidad_especie (
        id SERIAL PRIMARY KEY,
        id_especie INTEGER REFERENCES especies(id),
        nombre_parametro VARCHAR(50) NOT NULL,
        valor_base DECIMAL(8,3) NOT NULL,
        tolerancia DECIMAL(8,3) NOT NULL,
        descuento_por_punto DECIMAL(8,4),
        bonificacion_por_punto DECIMAL(8,4),
        unidad VARCHAR(20) DEFAULT '%',
        orden INTEGER DEFAULT 0,
        activo BOOLEAN DEFAULT TRUE
      );

      CREATE TABLE IF NOT EXISTS cotizaciones (
        id SERIAL PRIMARY KEY,
        fecha DATE NOT NULL UNIQUE,
        dolar_oficial DECIMAL(12,4),
        dolar_billete DECIMAL(12,4),
        fuente VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS contrapartes (
        id SERIAL PRIMARY KEY,
        codigo_interno VARCHAR(20) NOT NULL UNIQUE,
        cuit VARCHAR(13),
        razon_social VARCHAR(200) NOT NULL,
        nombre_fantasia VARCHAR(200),
        condicion_iva VARCHAR(30),
        tipo_contraparte VARCHAR(20) NOT NULL,
        canal_operacion VARCHAR(20) NOT NULL DEFAULT 'AMBOS',
        domicilio VARCHAR(200),
        localidad VARCHAR(100),
        provincia VARCHAR(100),
        telefono VARCHAR(50),
        email VARCHAR(100),
        activo BOOLEAN DEFAULT TRUE,
        observaciones TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS transportistas (
        id SERIAL PRIMARY KEY,
        codigo_interno VARCHAR(20) NOT NULL UNIQUE,
        modalidad VARCHAR(20) NOT NULL,
        cuit VARCHAR(13),
        razon_social VARCHAR(200) NOT NULL,
        condicion_iva VARCHAR(30),
        localidad VARCHAR(100),
        provincia VARCHAR(100),
        telefono VARCHAR(50),
        activo BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS choferes (
        id SERIAL PRIMARY KEY,
        cuit_dni VARCHAR(13) NOT NULL,
        nombre_completo VARCHAR(200) NOT NULL,
        telefono VARCHAR(50),
        id_transportista INTEGER REFERENCES transportistas(id),
        activo BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS vehiculos (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(20) NOT NULL,
        patente VARCHAR(10) NOT NULL UNIQUE,
        marca VARCHAR(50),
        modelo VARCHAR(50),
        activo BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ubicaciones (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(200) NOT NULL,
        tipo VARCHAR(30) NOT NULL,
        localidad VARCHAR(100),
        provincia VARCHAR(100),
        direccion VARCHAR(200),
        cuit_titular VARCHAR(13),
        nro_planta VARCHAR(20),
        activo BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS contratos (
        id SERIAL PRIMARY KEY,
        numero_contrato VARCHAR(30) NOT NULL UNIQUE,
        tipo_contrato VARCHAR(20) NOT NULL,
        modalidad VARCHAR(20) NOT NULL,
        tipo_liquidacion VARCHAR(20),
        fecha_contrato DATE NOT NULL,
        fecha_entrega_desde DATE,
        fecha_entrega_hasta DATE,
        id_contraparte INTEGER REFERENCES contrapartes(id),
        id_especie INTEGER REFERENCES especies(id),
        id_campana INTEGER REFERENCES campanas(id),
        cantidad_toneladas_pactadas DECIMAL(12,3) NOT NULL,
        cantidad_toneladas_asignadas DECIMAL(12,3) DEFAULT 0,
        tipo_precio VARCHAR(20) NOT NULL,
        moneda VARCHAR(20),
        precio_pactado DECIMAL(14,4),
        referencia_fijacion VARCHAR(20),
        diferencial_fijacion DECIMAL(14,4),
        tipo_diferencial VARCHAR(10),
        precio_fijado DECIMAL(14,4),
        fecha_fijacion DATE,
        tipo_entrega VARCHAR(20),
        localidad_entrega VARCHAR(100),
        provincia_entrega VARCHAR(100),
        flete_estimado DECIMAL(12,4),
        distancia_km_estimada DECIMAL(8,2),
        forma_pago VARCHAR(30),
        plazo_pago_dias INTEGER DEFAULT 0,
        condicion_pago VARCHAR(20),
        id_comisionista INTEGER REFERENCES contrapartes(id),
        comision_porcentaje DECIMAL(6,4),
        precio_venta_estimado DECIMAL(14,4),
        destino_venta_estimado VARCHAR(200),
        costo_secada_punto DECIMAL(14,4) DEFAULT 0,
        costo_zarandeo_tn DECIMAL(14,4) DEFAULT 0,
        costo_paritaria_tn DECIMAL(14,4) DEFAULT 0,
        costo_fumigacion_fijo DECIMAL(14,4) DEFAULT 0,
        humedad_max_seco DECIMAL(8,2) DEFAULT 13.5,
        otros_descripcion VARCHAR(200),
        costo_secada_destino_punto DECIMAL(14,4) DEFAULT 0,
        costo_zarandeo_destino_tn DECIMAL(14,4) DEFAULT 0,
        costo_paritaria_destino_tn DECIMAL(14,4) DEFAULT 0,
        costo_fumigacion_destino_fijo DECIMAL(14,4) DEFAULT 0,
        otros_destino_descripcion VARCHAR(200),
        costo_otros_destino_valor DECIMAL(14,4) DEFAULT 0,
        estado VARCHAR(20) DEFAULT 'BORRADOR',
        activo BOOLEAN DEFAULT TRUE,
        observaciones TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS movimientos (
        id SERIAL PRIMARY KEY,
        numero_movimiento VARCHAR(30) NOT NULL UNIQUE,
        modalidad VARCHAR(20) NOT NULL,
        estado VARCHAR(20) DEFAULT 'BORRADOR',
        estado_liquidacion VARCHAR(20) DEFAULT 'SIN_ASIGNAR',
        estado_flete VARCHAR(20) DEFAULT 'PENDIENTE',
        id_contrato_compra INTEGER REFERENCES contratos(id),
        id_contrato_venta INTEGER REFERENCES contratos(id),
        nro_cpe VARCHAR(30),
        nro_ctg VARCHAR(30),
        fecha_cpe DATE,
        fecha_vencimiento_cpe DATE,
        titular_cpe_cuit VARCHAR(13),
        titular_cpe_nombre VARCHAR(200),
        remitente_comercial_productor_cuit VARCHAR(13),
        remitente_comercial_productor_nombre VARCHAR(200),
        rte_comercial_venta_primaria_cuit VARCHAR(13),
        rte_comercial_venta_primaria_nombre VARCHAR(200),
        rte_comercial_venta_secundaria_cuit VARCHAR(13),
        rte_comercial_venta_secundaria_nombre VARCHAR(200),
        corredor_venta_primaria_cuit VARCHAR(13),
        corredor_venta_primaria_nombre VARCHAR(200),
        destinatario_cuit VARCHAR(13),
        destinatario_nombre VARCHAR(200),
        destino_cuit VARCHAR(13),
        destino_nombre VARCHAR(200),
        flete_pagador_cuit VARCHAR(13),
        flete_pagador_nombre VARCHAR(200),
        id_especie INTEGER REFERENCES especies(id),
        id_campana INTEGER REFERENCES campanas(id),
        declaracion_calidad VARCHAR(20),
        renspa VARCHAR(50),
        localidad_origen VARCHAR(100),
        provincia_origen VARCHAR(100),
        latitud VARCHAR(30),
        longitud VARCHAR(30),
        descripcion_campo VARCHAR(200),
        nro_planta_destino VARCHAR(20),
        localidad_destino VARCHAR(100),
        provincia_destino VARCHAR(100),
        id_transportista INTEGER REFERENCES transportistas(id),
        id_chofer INTEGER REFERENCES choferes(id),
        patente_chasis VARCHAR(10),
        patente_acoplado VARCHAR(10),
        fecha_partida TIMESTAMP,
        km_a_recorrer DECIMAL(8,2),
        tarifa_catac DECIMAL(10,4),
        tarifa_flete_real DECIMAL(10,4),
        tipo_tarifa VARCHAR(20),
        peso_bruto_salida_kg DECIMAL(12,3),
        peso_tara_salida_kg DECIMAL(12,3),
        peso_neto_salida_kg DECIMAL(12,3),
        humedad_salida_pct DECIMAL(6,3),
        fecha_arribo TIMESTAMP,
        fecha_descarga TIMESTAMP,
        nro_turno VARCHAR(50),
        peso_bruto_llegada_kg DECIMAL(12,3),
        peso_tara_llegada_kg DECIMAL(12,3),
        peso_neto_llegada_kg DECIMAL(12,3),
        humedad_llegada_pct DECIMAL(6,3),
        diferencia_kg DECIMAL(12,3),
        tolerancia_kg DECIMAL(12,3),
        faltante_kg DECIMAL(12,3),
        valor_faltante DECIMAL(14,4),
        tipo_factor VARCHAR(20) DEFAULT 'CALCULADO',
        factor_calculado DECIMAL(8,6),
        factor_manual DECIMAL(8,6),
        factor_aplicado DECIMAL(8,6),
        kg_liquidables DECIMAL(12,3),
        observaciones TEXT,
        codigo_preliquidacion VARCHAR(50),
        calidad_tipo_ajuste VARCHAR(20) DEFAULT 'FACTOR',
        calidad_valor_ajuste DECIMAL(12,4),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS calidad_movimiento (
        id SERIAL PRIMARY KEY,
        id_movimiento INTEGER REFERENCES movimientos(id),
        id_parametro INTEGER REFERENCES parametros_calidad_especie(id),
        valor_declarado_pct DECIMAL(8,3),
        tolerancia_parametro_pct DECIMAL(8,3),
        exceso_sobre_tolerancia_pct DECIMAL(8,3),
        factor_descuento_bonificacion_pct DECIMAL(8,4),
        kg_ajustados DECIMAL(12,3)
      );

      CREATE TABLE IF NOT EXISTS servicios_movimiento (
        id SERIAL PRIMARY KEY,
        id_movimiento INTEGER REFERENCES movimientos(id),
        aplicado_a VARCHAR(10) NOT NULL,
        tipo_servicio VARCHAR(30) NOT NULL,
        descripcion VARCHAR(100),
        unidad VARCHAR(20),
        valor_unitario_pactado DECIMAL(12,4),
        valor_unitario_real DECIMAL(12,4),
        cantidad_aplicada DECIMAL(10,4),
        monto_pactado DECIMAL(14,4),
        monto_real DECIMAL(14,4)
      );

      CREATE TABLE IF NOT EXISTS liquidaciones (
        id SERIAL PRIMARY KEY,
        nro_liquidacion VARCHAR(30) NOT NULL UNIQUE,
        tipo VARCHAR(10) NOT NULL,
        modalidad VARCHAR(20) NOT NULL,
        tipo_liquidacion VARCHAR(20),
        id_contrato INTEGER REFERENCES contratos(id),
        id_contraparte INTEGER REFERENCES contrapartes(id),
        fecha_liquidacion DATE NOT NULL,
        monto_bruto_total DECIMAL(14,4),
        total_descuentos_servicios DECIMAL(14,4),
        total_retenciones DECIMAL(14,4),
        monto_neto_a_pagar DECIMAL(14,4),
        moneda VARCHAR(20),
        estado VARCHAR(20) DEFAULT 'BORRADOR',
        observaciones TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS liquidacion_movimientos (
        id SERIAL PRIMARY KEY,
        id_liquidacion INTEGER REFERENCES liquidaciones(id),
        id_movimiento INTEGER REFERENCES movimientos(id) UNIQUE,
        kg_liquidables DECIMAL(12,3),
        factor_aplicado DECIMAL(8,6),
        precio_aplicado DECIMAL(14,4),
        moneda VARCHAR(20),
        monto_bruto_parcial DECIMAL(14,4)
      );

      CREATE TABLE IF NOT EXISTS cc_contrapartes (
        id SERIAL PRIMARY KEY,
        id_contraparte INTEGER REFERENCES contrapartes(id),
        id_liquidacion INTEGER REFERENCES liquidaciones(id),
        id_contrato INTEGER REFERENCES contratos(id),
        fecha DATE NOT NULL,
        tipo_movimiento VARCHAR(20) NOT NULL,
        concepto VARCHAR(200),
        debe DECIMAL(14,4) DEFAULT 0,
        haber DECIMAL(14,4) DEFAULT 0,
        saldo_acumulado DECIMAL(14,4),
        modalidad VARCHAR(20),
        estado VARCHAR(20) DEFAULT 'ABIERTO',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS cc_transportistas (
        id SERIAL PRIMARY KEY,
        id_transportista INTEGER REFERENCES transportistas(id),
        id_movimiento INTEGER REFERENCES movimientos(id),
        fecha DATE NOT NULL,
        concepto VARCHAR(20) NOT NULL,
        descripcion VARCHAR(200),
        debe DECIMAL(14,4) DEFAULT 0,
        haber DECIMAL(14,4) DEFAULT 0,
        saldo_acumulado DECIMAL(14,4),
        estado VARCHAR(20) DEFAULT 'ABIERTO',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS stock (
        id SERIAL PRIMARY KEY,
        id_ubicacion INTEGER REFERENCES ubicaciones(id),
        id_especie INTEGER REFERENCES especies(id),
        id_campana INTEGER REFERENCES campanas(id),
        toneladas_totales DECIMAL(12,3) DEFAULT 0,
        toneladas_con_precio DECIMAL(12,3) DEFAULT 0,
        toneladas_a_fijar DECIMAL(12,3) DEFAULT 0,
        toneladas_comprometidas DECIMAL(12,3) DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(id_ubicacion, id_especie, id_campana)
      );

      CREATE TABLE IF NOT EXISTS mermas_humedad (
        id SERIAL PRIMARY KEY,
        id_especie INTEGER REFERENCES especies(id),
        humedad DECIMAL(5,2) NOT NULL,
        merma_porcentaje DECIMAL(5,2) NOT NULL,
        UNIQUE(id_especie, humedad)
      );

      CREATE TABLE IF NOT EXISTS tablas_flete (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL UNIQUE,
        activa BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tarifas_flete (
        id SERIAL PRIMARY KEY,
        id_tabla INTEGER REFERENCES tablas_flete(id) ON DELETE CASCADE,
        km INTEGER NOT NULL,
        valor_tonelada DECIMAL(12,4) NOT NULL,
        UNIQUE(id_tabla, km)
      );
    `);

    // Migración para relaciones de contrapartes, usuario de carga y reportes
    await client.query(`
      ALTER TABLE contrapartes ADD COLUMN IF NOT EXISTS id_contraparte_relacionada INTEGER REFERENCES contrapartes(id);
      ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS usuario_carga VARCHAR(50);
      ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS chofer_nombre VARCHAR(200);
      ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS transportista_nombre VARCHAR(200);
      ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS nro_factura_flete VARCHAR(50);
      ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS codigo_preliquidacion VARCHAR(50);
      ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS estado_flete VARCHAR(20) DEFAULT 'PENDIENTE';
      ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS calidad_tipo_ajuste VARCHAR(20) DEFAULT 'FACTOR';
      ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS calidad_valor_ajuste DECIMAL(12,4);
      ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS id_movimiento_vinculado INTEGER REFERENCES movimientos(id);
      ALTER TABLE fijaciones_contrato ADD COLUMN IF NOT EXISTS precio_referencia DECIMAL(14,4);
      ALTER TABLE fijaciones_contrato ADD COLUMN IF NOT EXISTS descuento_pct DECIMAL(8,4);

      -- Inicializar estado_flete basado en campos de flete existentes
      UPDATE movimientos SET estado_flete = 'LIQUIDADO' WHERE nro_factura_flete IS NOT NULL AND (estado_flete IS NULL OR estado_flete = 'PENDIENTE');
      UPDATE movimientos SET estado_flete = 'PRELIQUIDADO' WHERE codigo_preliquidacion IS NOT NULL AND nro_factura_flete IS NULL AND (estado_flete IS NULL OR estado_flete = 'PENDIENTE');

      -- Restaurar estado_liquidacion de granos para movimientos que tenían conflicto por liquidación de fletes
      UPDATE movimientos 
      SET estado_liquidacion = CASE 
            WHEN id_contrato_compra IS NOT NULL OR id_contrato_venta IS NOT NULL THEN 'ASIGNADO' 
            ELSE 'SIN_ASIGNAR' 
          END 
      WHERE (estado_liquidacion = 'PRELIQUIDADO' OR (estado_liquidacion = 'LIQUIDADO' AND id NOT IN (SELECT id_movimiento FROM liquidacion_movimientos)));

      CREATE TABLE IF NOT EXISTS reportes_ia (
        id SERIAL PRIMARY KEY,
        titulo VARCHAR(200) NOT NULL,
        prompt TEXT NOT NULL,
        sql_query TEXT NOT NULL,
        columnas TEXT[] NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        usuario VARCHAR(50) UNIQUE NOT NULL,
        contrasena VARCHAR(100) NOT NULL,
        nombre VARCHAR(100),
        rol VARCHAR(20) DEFAULT 'OPERADOR',
        activo BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS fijaciones_contrato (
        id SERIAL PRIMARY KEY,
        id_contrato INTEGER NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
        fecha DATE NOT NULL,
        cantidad_toneladas DECIMAL(12,3) NOT NULL,
        precio_fijado DECIMAL(14,4) NOT NULL,
        observaciones VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS propuestas_aprobacion (
        id SERIAL PRIMARY KEY,
        tipo_accion VARCHAR(50) NOT NULL,
        modulo VARCHAR(50) NOT NULL,
        datos_propuesta JSONB NOT NULL,
        estado VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
        explicacion TEXT,
        usuario_aprobador VARCHAR(100),
        fecha_aprobacion TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS staging_movimientos (
        id SERIAL PRIMARY KEY,
        telefono_remitente VARCHAR(20),
        mensaje_texto TEXT,
        patente_camion VARCHAR(10) NOT NULL,
        kilos_netos DECIMAL(12,3) NOT NULL,
        producto VARCHAR(50) NOT NULL,
        remitente_nombre VARCHAR(200),
        remitente_cuit VARCHAR(13),
        contrato_destino VARCHAR(50),
        doble_registro_aplicado BOOLEAN NOT NULL DEFAULT FALSE,
        datos_extraidos_raw JSONB,
        media_url TEXT,
        estado VARCHAR(30) NOT NULL DEFAULT 'Pendiente_Autorizacion',
        usuario_validador VARCHAR(100),
        fecha_validacion TIMESTAMP,
        id_movimiento INTEGER REFERENCES movimientos(id),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Sembrar usuario administrador por defecto
    const { rows: userCount } = await client.query("SELECT id FROM usuarios WHERE usuario = 'admin'");
    if (userCount.length === 0) {
      const adminPass = crypto.createHash('sha256').update('admin123').digest('hex');
      await client.query(`
        INSERT INTO usuarios (usuario, contrasena, nombre, rol, activo)
        VALUES ($1, $2, $3, 'ADMIN', TRUE)
      `, ['admin', adminPass, 'Administrador']);
      console.log('Usuario administrador sembrado correctamente.');
    }

    // Insertar datos iniciales si no existen
    const { rows: campanas } = await client.query('SELECT id FROM campanas LIMIT 1');
    if (campanas.length === 0) {
      await client.query(`
        INSERT INTO campanas (descripcion, anio_inicio, anio_fin, activa) VALUES
        ('2023/2024', 2023, 2024, FALSE),
        ('2024/2025', 2024, 2025, TRUE),
        ('2025/2026', 2025, 2026, TRUE);

        INSERT INTO especies (nombre, codigo) VALUES
        ('Soja', 'SOJ'), ('Trigo', 'TRI'), ('Maíz', 'MAI'),
        ('Girasol', 'GIR'), ('Sorgo', 'SOR'), ('Cebada', 'CEB');

        INSERT INTO ubicaciones (nombre, tipo, localidad, provincia) VALUES
        ('Planta Propia', 'PLANTA_PROPIA', 'Santiago del Estero', 'Santiago del Estero');
      `);
    }

    // Sembrar tabla mermas_humedad
    const { rows: mermasExist } = await client.query('SELECT id FROM mermas_humedad LIMIT 1');
    if (mermasExist.length === 0) {
      console.log('Sembrando tabla mermas_humedad...');
      let mermasMap = null;
      try {
        const XLSX = require('xlsx');
        const excelPath = "C:/Users/JCMARZILIO/Desktop/tabla de mermas humedad.xlsx";
        const wb = XLSX.readFile(excelPath);
        const sheet = wb.Sheets["tabla de mermas"];
        if (sheet) {
          const data = XLSX.utils.sheet_to_json(sheet, {header: 1});
          mermasMap = { soja: [], maiz: [], trigo: [] };
          for (let i = 2; i < data.length; i++) {
            const row = data[i];
            // Maiz (col 0, 1)
            if (row[0] !== undefined && row[1] !== undefined) {
              mermasMap.maiz.push({ hum: parseFloat(row[0]), merma: parseFloat(row[1]) });
            }
            // Soja (col 3, 4)
            if (row[3] !== undefined && row[4] !== undefined) {
              mermasMap.soja.push({ hum: parseFloat(row[3]), merma: parseFloat(row[4]) });
            }
            // Trigo (col 6, 7)
            if (row[6] !== undefined && row[7] !== undefined) {
              mermasMap.trigo.push({ hum: parseFloat(row[6]), merma: parseFloat(row[7]) });
            }
          }
        }
      } catch (err) {
        console.log('No se pudo leer el Excel de mermas, usando fallback estático:', err.message);
      }

      if (!mermasMap) {
        mermasMap = require('./services/mermas_fallback.json');
        // Transformar formato fallback { "13.6": 0.94 } a [{ hum: 13.6, merma: 0.94 }]
        const transform = obj => Object.keys(obj).map(k => ({ hum: parseFloat(k), merma: obj[k] }));
        mermasMap = {
          soja: transform(mermasMap.soja),
          maiz: transform(mermasMap.maiz),
          trigo: transform(mermasMap.trigo)
        };
      }

      // Insertar Soja (1), Trigo (2), Maíz (3)
      for (const item of mermasMap.soja) {
        await client.query('INSERT INTO mermas_humedad (id_especie, humedad, merma_porcentaje) VALUES (1, $1, $2) ON CONFLICT DO NOTHING', [item.hum, item.merma]);
      }
      for (const item of mermasMap.trigo) {
        await client.query('INSERT INTO mermas_humedad (id_especie, humedad, merma_porcentaje) VALUES (2, $1, $2) ON CONFLICT DO NOTHING', [item.hum, item.merma]);
      }
      for (const item of mermasMap.maiz) {
        await client.query('INSERT INTO mermas_humedad (id_especie, humedad, merma_porcentaje) VALUES (3, $1, $2) ON CONFLICT DO NOTHING', [item.hum, item.merma]);
      }

      // Generar Girasol (id_especie = 4) con base de humedad 11.0%
      for (let h = 11.1; h <= 25.05; h += 0.1) {
        const hum = Math.round(h * 10) / 10;
        const merma = Math.round(((hum - 11.0) * 1.15 + 0.25) * 100) / 100;
        await client.query('INSERT INTO mermas_humedad (id_especie, humedad, merma_porcentaje) VALUES (4, $1, $2) ON CONFLICT DO NOTHING', [hum, merma]);
      }
      console.log('Semilla de mermas_humedad completada.');
    }

    // Sembrar tabla parametros_calidad_especie si no existen
    const { rows: paramsExist } = await client.query('SELECT id FROM parametros_calidad_especie LIMIT 1');
    if (paramsExist.length === 0) {
      console.log('Sembrando tabla parametros_calidad_especie...');
      // Soja (id_especie = 1)
      await client.query(`
        INSERT INTO parametros_calidad_especie (id_especie, nombre_parametro, valor_base, tolerancia, descuento_por_punto, bonificacion_por_punto, orden) VALUES
        (1, 'Humedad', 13.5, 13.5, 1.0, 0.0, 1),
        (1, 'Materia Extraña', 1.0, 1.0, 1.0, 0.0, 2),
        (1, 'Grano Dañado', 3.0, 3.0, 1.0, 0.0, 3),
        (1, 'Grano Verde', 5.0, 5.0, 1.0, 0.0, 4);
      `);

      // Trigo (id_especie = 2)
      await client.query(`
        INSERT INTO parametros_calidad_especie (id_especie, nombre_parametro, valor_base, tolerancia, descuento_por_punto, bonificacion_por_punto, orden) VALUES
        (2, 'Humedad', 14.0, 14.0, 1.0, 0.0, 1),
        (2, 'Materia Extraña', 0.75, 0.75, 1.0, 0.0, 2),
        (2, 'Grano Dañado', 1.0, 1.0, 1.0, 0.0, 3);
      `);

      // Maíz (id_especie = 3)
      await client.query(`
        INSERT INTO parametros_calidad_especie (id_especie, nombre_parametro, valor_base, tolerancia, descuento_por_punto, bonificacion_por_punto, orden) VALUES
        (3, 'Humedad', 14.5, 14.5, 1.0, 0.0, 1),
        (3, 'Materia Extraña', 1.5, 1.5, 1.0, 0.0, 2),
        (3, 'Grano Dañado', 3.0, 3.0, 1.0, 0.0, 3),
        (3, 'Quebrados', 3.0, 3.0, 0.5, 0.0, 4);
      `);

      // Girasol (id_especie = 4)
      await client.query(`
        INSERT INTO parametros_calidad_especie (id_especie, nombre_parametro, valor_base, tolerancia, descuento_por_punto, bonificacion_por_punto, orden) VALUES
        (4, 'Humedad', 11.0, 11.0, 1.0, 0.0, 1),
        (4, 'Materia Extraña', 1.5, 1.5, 1.0, 0.0, 2);
      `);
      console.log('Semilla de parametros_calidad_especie completada.');
    }

    // Sembrar transportistas y choferes si no existen
    const { rows: tExist } = await client.query('SELECT id FROM transportistas LIMIT 1');
    if (tExist.length === 0) {
      console.log('Sembrando transportistas y choferes iniciales...');
      const { rows: t1 } = await client.query(`
        INSERT INTO transportistas (codigo_interno, modalidad, cuit, razon_social, condicion_iva, activo)
        VALUES ('T-0001', 'FORMAL', '30-71020619-4', 'Logística Centro S.R.L.', 'RI', TRUE)
        RETURNING id
      `);
      const { rows: t2 } = await client.query(`
        INSERT INTO transportistas (codigo_interno, modalidad, cuit, razon_social, condicion_iva, activo)
        VALUES ('T-0002', 'FORMAL', '20-18234567-8', 'Transportes del Norte', 'RI', TRUE)
        RETURNING id
      `);
      const { rows: t3 } = await client.query(`
        INSERT INTO transportistas (codigo_interno, modalidad, cuit, razon_social, condicion_iva, activo)
        VALUES ('T-0003', 'INFORMAL', NULL, 'Fletes Rápidos', 'CF', TRUE)
        RETURNING id
      `);
      await client.query(`
        INSERT INTO transportistas (codigo_interno, modalidad, cuit, razon_social, condicion_iva, activo)
        VALUES ('T-0004', 'FORMAL', '20-24567890-1', 'García Transporte S.A.', 'RI', TRUE)
      `);
      await client.query(`
        INSERT INTO choferes (cuit_dni, nombre_completo, id_transportista, activo) VALUES
        ('20-26504588-0', 'Zamora Pablo Leandro', $1, TRUE),
        ('20-31234567-9', 'López Mario Alberto', $1, TRUE),
        ('20-28765432-1', 'Ramírez Pedro José', $2, TRUE),
        ('20-22345678-3', 'Fernández Juan Carlos', $3, TRUE)
      `, [t1[0].id, t2[0].id, t3[0].id]);
      console.log('Semilla de transportistas y choferes completada.');
    }


    // Recalcular mermas por humedad retroactivas para todos los movimientos descargados basados en mermas_humedad
    await client.query(`
      UPDATE movimientos m SET
        factor_calculado = 1.0,
        factor_aplicado = CASE WHEN m.factor_manual IS NOT NULL THEN m.factor_manual ELSE 1.0 END,
        kg_liquidables = m.peso_neto_llegada_kg * (1.0 - (mh.merma_porcentaje / 100.0)) * CASE WHEN m.factor_manual IS NOT NULL THEN m.factor_manual ELSE 1.0 END,
        updated_at = NOW()
      FROM mermas_humedad mh
      WHERE m.id_especie = mh.id_especie
        AND ROUND(m.humedad_llegada_pct, 1) = mh.humedad
        AND m.peso_neto_llegada_kg IS NOT NULL
        AND (m.factor_aplicado IS NULL OR m.factor_aplicado = 1.0)
    `);

    // Migración de columnas de costos de contratos
    const columnsContratos = [
      { name: "costo_secada_punto", type: "DECIMAL(14,4) DEFAULT 0" },
      { name: "costo_zarandeo_tn", type: "DECIMAL(14,4) DEFAULT 0" },
      { name: "costo_paritaria_tn", type: "DECIMAL(14,4) DEFAULT 0" },
      { name: "costo_fumigacion_fijo", type: "DECIMAL(14,4) DEFAULT 0" },
      { name: "humedad_max_seco", type: "DECIMAL(8,2) DEFAULT 13.5" },
      { name: "otros_descripcion", type: "VARCHAR(200)" },
      { name: "costo_secada_destino_punto", type: "DECIMAL(14,4) DEFAULT 0" },
      { name: "costo_zarandeo_destino_tn", type: "DECIMAL(14,4) DEFAULT 0" },
      { name: "costo_paritaria_destino_tn", type: "DECIMAL(14,4) DEFAULT 0" },
      { name: "costo_fumigacion_destino_fijo", type: "DECIMAL(14,4) DEFAULT 0" },
      { name: "otros_destino_descripcion", type: "VARCHAR(200)" },
      { name: "costo_otros_destino_valor", type: "DECIMAL(14,4) DEFAULT 0" },
      { name: "es_canje", type: "BOOLEAN DEFAULT FALSE" },
      { name: "id_contrato_canje_relacionado", type: "INTEGER REFERENCES contratos(id)" },
      { name: "descripcion_relacion_canje", type: "VARCHAR(200)" },
      { name: "base_calculo_peso", type: "VARCHAR(30) DEFAULT 'BRUTO_CAMPO'" },
      // Usadas por routes/contratos.js (POST/PUT) pero nunca creadas hasta ahora
      { name: "localidad_entrega_pactada", type: "VARCHAR(100)" },
      { name: "comprador_estimado_id", type: "INTEGER REFERENCES contrapartes(id)" },
      { name: "aplica_cpe", type: "BOOLEAN DEFAULT FALSE" },
      { name: "costo_cpe_pct", type: "DECIMAL(8,4)" },
      { name: "costo_financiero_pct", type: "DECIMAL(8,4)" },
      { name: "precio_referencia", type: "DECIMAL(14,4)" },
      { name: "descuento_precio_pct", type: "DECIMAL(8,4)" }
    ];
    for (const col of columnsContratos) {
      try {
        await client.query(`ALTER TABLE contratos ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
      } catch (err) {
        console.error(`Error al crear columna ${col.name}:`, err.message);
      }
    }

    console.log('Base de datos inicializada correctamente');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
