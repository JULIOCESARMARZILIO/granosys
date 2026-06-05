const router = require('express').Router();
const { pool } = require('../db');
const Afip = require('@afipsdk/afip.js');
const fs = require('fs');
const path = require('path');

// Función auxiliar para preparar certificados de AFIP
function obtenerRutasCertificados() {
  const afipCuit = process.env.AFIP_CUIT;
  const afipCertStr = process.env.AFIP_CERT;
  const afipKeyStr = process.env.AFIP_KEY;

  if (!afipCuit || !afipCertStr || !afipKeyStr) {
    return null;
  }

  // Rutas locales temporales para escribir los certificados si se proveen como cadenas
  const certPath = path.join(__dirname, '../../afip.crt');
  const keyPath = path.join(__dirname, '../../afip.key');

  try {
    // Si contienen cabeceras PEM, escribir a archivos locales
    if (afipCertStr.includes('-----BEGIN')) {
      fs.writeFileSync(certPath, afipCertStr.trim());
    } else {
      return null;
    }
    
    if (afipKeyStr.includes('-----BEGIN')) {
      fs.writeFileSync(keyPath, afipKeyStr.trim());
    } else {
      return null;
    }

    return {
      cuit: afipCuit,
      cert: certPath,
      key: keyPath
    };
  } catch (e) {
    console.error('Error al escribir certificados de AFIP en disco:', e);
    return null;
  }
}

// GET consultar cuit en ARCA/AFIP
router.get('/consulta-arca/:cuit', async (req, res) => {
  try {
    const { cuit } = req.params;
    const cuitLimpio = cuit.replace(/[^0-9]/g, '');

    if (cuitLimpio.length !== 11) {
      return res.status(400).json({ error: 'El CUIT debe tener exactamente 11 dígitos' });
    }

    const creds = obtenerRutasCertificados();
    const afipProd = process.env.AFIP_PROD === 'true';

    // Si no están configuradas las credenciales reales, devolvemos un mock de desarrollo
    if (!creds) {
      console.log(`[ARCA Mock] Consultando CUIT: ${cuitLimpio}`);
      await new Promise(resolve => setTimeout(resolve, 800));

      if (cuitLimpio.startsWith('20') || cuitLimpio.startsWith('23') || cuitLimpio.startsWith('27') || cuitLimpio.startsWith('30')) {
        let razonSocial = 'Cliente Autocompletado S.A.';
        let condicionIva = 'RI';
        let domicilio = 'Av. Leandro N. Alem 850';
        let localidad = 'Rosario';
        let provincia = 'Santa Fe';

        if (cuitLimpio.startsWith('20') || cuitLimpio.startsWith('23')) {
          razonSocial = 'Martínez Juan Carlos (Prueba ARCA)';
          condicionIva = 'MONO';
          domicilio = 'Rivadavia 452';
          localidad = 'La Banda';
          provincia = 'Santiago del Estero';
        } else if (cuitLimpio.startsWith('30')) {
          razonSocial = 'Agronorte Cereales S.A. (Prueba ARCA)';
          condicionIva = 'RI';
          domicilio = 'Ruta 34 Km 62';
          localidad = 'Rafaela';
          provincia = 'Santa Fe';
        }

        return res.json({
          cuit: cuitLimpio,
          razon_social: razonSocial,
          condicion_iva: condicionIva,
          domicilio,
          localidad,
          provincia,
          origen: 'MOCK_ARCA_DESARROLLO'
        });
      } else {
        return res.status(404).json({ error: 'CUIT no encontrado en el padrón de desarrollo' });
      }
    }

    // Inicializar AFIP con los certificados en disco
    const afip = new Afip({
      CUIT: parseInt(creds.cuit),
      cert: creds.cert,
      key: creds.key,
      production: afipProd
    });

    // Envolver la consulta con un timeout de 5 segundos para que no se tilde el backend
    const consultaPromise = afip.RegisterInscriptionProof.getTaxpayerDetails(parseInt(cuitLimpio));
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('TIMEOUT_ARCA')), 5000)
    );

    const data = await Promise.race([consultaPromise, timeoutPromise]);

    if (!data) {
      return res.status(404).json({ error: 'No se encontraron datos para ese CUIT en los registros de ARCA' });
    }

    const datosGenerales = data.datosGenerales || {};
    const domicilioFiscal = datosGenerales.domicilioFiscal || {};

    let razonSocial = datosGenerales.razonSocial;
    if (!razonSocial && (datosGenerales.nombre || datosGenerales.apellido)) {
      razonSocial = `${datosGenerales.apellido || ''} ${datosGenerales.nombre || ''}`.trim();
    }

    let condicionIva = 'RI';
    if (data.datosRegimenGeneral && data.datosRegimenGeneral.impuesto) {
      const impuestos = Array.isArray(data.datosRegimenGeneral.impuesto) 
        ? data.datosRegimenGeneral.impuesto 
        : [data.datosRegimenGeneral.impuesto];
      
      const tieneMono = impuestos.some(imp => imp.idImpuesto === 20 || (imp.descripcion && imp.descripcion.toLowerCase().includes('monotributo')));
      const tieneExento = impuestos.some(imp => imp.idImpuesto === 32 || (imp.descripcion && imp.descripcion.toLowerCase().includes('exento')));
      
      if (tieneMono) condicionIva = 'MONO';
      else if (tieneExento) condicionIva = 'EXENTO';
    } else if (data.datosMonotributo) {
      condicionIva = 'MONO';
    }

    let provincia = '';
    const descProvincia = (domicilioFiscal.descripcionProvincia || '').toLowerCase();
    if (descProvincia.includes('santiago')) provincia = 'Santiago del Estero';
    else if (descProvincia.includes('santa fe')) provincia = 'Santa Fe';
    else if (descProvincia.includes('crdoba') || descProvincia.includes('cordoba')) provincia = 'Córdoba';
    else if (descProvincia.includes('buenos aires') || descProvincia.includes('capital') || descProvincia.includes('federal')) provincia = 'Buenos Aires';
    else if (descProvincia.includes('tucuman') || descProvincia.includes('tucumán')) provincia = 'Tucumán';
    else if (descProvincia.includes('chaco')) provincia = 'Chaco';
    else if (descProvincia.includes('salta')) provincia = 'Salta';
    else if (descProvincia.includes('jujuy')) provincia = 'Jujuy';
    else if (descProvincia.includes('entre r')) provincia = 'Entre Ríos';
    else if (descProvincia.includes('corrientes')) provincia = 'Corrientes';
    else if (descProvincia.includes('pampa')) provincia = 'La Pampa';
    else if (descProvincia.includes('san luis')) provincia = 'San Luis';
    else if (descProvincia.includes('catamarca')) provincia = 'Catamarca';
    else if (descProvincia.includes('rioja')) provincia = 'La Rioja';
    else if (descProvincia.includes('san juan')) provincia = 'San Juan';
    else if (descProvincia.includes('mendoza')) provincia = 'Mendoza';

    res.json({
      cuit: cuitLimpio,
      razon_social: razonSocial || '',
      condicion_iva: condicionIva,
      domicilio: domicilioFiscal.direccion || '',
      localidad: domicilioFiscal.localidad || '',
      provincia: provincia || domicilioFiscal.descripcionProvincia || '',
      origen: 'ARCA_PRODUCCION'
    });

  } catch (err) {
    console.error('Error en consulta ARCA:', err);
    if (err.message === 'TIMEOUT_ARCA') {
      res.status(504).json({ error: 'La consulta a ARCA demoró demasiado. Puedes continuar rellenando los datos manualmente.' });
    } else {
      res.status(500).json({ error: `No se pudo conectar con ARCA (${err.message}). Puedes completar los datos del cliente manualmente.` });
    }
  }
});

// GET todas las contrapartes
router.get('/', async (req, res) => {
  try {
    const { tipo, search } = req.query;
    let query = 'SELECT * FROM contrapartes WHERE 1=1';
    const params = [];

    if (tipo) {
      params.push(tipo);
      query += ` AND (tipo_contraparte = $${params.length} OR tipo_contraparte = 'AMBOS')`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (razon_social ILIKE $${params.length} OR cuit ILIKE $${params.length})`;
    }
    query += ' ORDER BY razon_social';

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET una contraparte
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM contrapartes WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrada' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST crear contraparte
router.post('/', async (req, res) => {
  try {
    const { cuit, razon_social, tipo_contraparte, canal_operacion, condicion_iva,
            domicilio, localidad, provincia, telefono, email, observaciones } = req.body;

    if (!cuit) {
      return res.status(400).json({ error: 'El CUIT es obligatorio' });
    }
    if (!razon_social) {
      return res.status(400).json({ error: 'La Razón Social es obligatoria' });
    }

    // Verificar unicidad de CUIT
    const { rows: existing } = await pool.query('SELECT id FROM contrapartes WHERE cuit = $1', [cuit]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Ya existe una contraparte registrada con ese CUIT' });
    }

    // Generar código interno
    const { rows: last } = await pool.query(
      "SELECT codigo_interno FROM contrapartes WHERE codigo_interno LIKE $1 ORDER BY id DESC LIMIT 1",
      [tipo_contraparte === 'COMPRADOR' ? 'C-%' : 'P-%']
    );
    const prefix = tipo_contraparte === 'COMPRADOR' ? 'C' : 'P';
    const num = last[0] ? parseInt(last[0].codigo_interno.split('-')[1]) + 1 : 1;
    const codigo_interno = `${prefix}-${String(num).padStart(4, '0')}`;

    const { rows } = await pool.query(`
      INSERT INTO contrapartes (codigo_interno, cuit, razon_social, tipo_contraparte,
        canal_operacion, condicion_iva, domicilio, localidad, provincia, telefono, email, observaciones)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [codigo_interno, cuit, razon_social, tipo_contraparte,
        canal_operacion||'AMBOS', condicion_iva, domicilio, localidad,
        provincia, telefono, email, observaciones]);

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT actualizar contraparte
router.put('/:id', async (req, res) => {
  try {
    const { cuit, razon_social, tipo_contraparte, condicion_iva,
            domicilio, localidad, provincia, telefono, email, activo } = req.body;

    if (!cuit) {
      return res.status(400).json({ error: 'El CUIT es obligatorio' });
    }
    if (!razon_social) {
      return res.status(400).json({ error: 'La Razón Social es obligatoria' });
    }

    // Verificar unicidad de CUIT en otras contrapartes
    const { rows: existing } = await pool.query('SELECT id FROM contrapartes WHERE cuit = $1 AND id <> $2', [cuit, req.params.id]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Ya existe otra contraparte registrada con ese CUIT' });
    }

    const { rows } = await pool.query(`
      UPDATE contrapartes SET
        cuit=$1, razon_social=$2, tipo_contraparte=$3, condicion_iva=$4,
        domicilio=$5, localidad=$6, provincia=$7, telefono=$8, email=$9,
        activo=$10, updated_at=NOW()
      WHERE id=$11 RETURNING *
    `, [cuit, razon_social, tipo_contraparte, condicion_iva,
        domicilio, localidad, provincia, telefono, email, activo !== undefined ? activo : true, req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// DELETE contraparte - solo si no tiene datos asociados
router.delete('/:id', async (req, res) => {
  try {
    // Verificar si tiene contratos
    const { rows: contratos } = await pool.query(
      'SELECT COUNT(*) as total FROM contratos WHERE id_contraparte = $1',
      [req.params.id]
    );
    if (parseInt(contratos[0].total) > 0) {
      return res.status(400).json({ 
        error: `No se puede eliminar — tiene ${contratos[0].total} contrato(s) asociado(s)` 
      });
    }
    // Verificar si tiene movimientos (como transportista)
    const { rows: movs } = await pool.query(
      'SELECT COUNT(*) as total FROM movimientos WHERE id_transportista = $1',
      [req.params.id]
    );
    if (parseInt(movs[0].total) > 0) {
      return res.status(400).json({ 
        error: `No se puede eliminar — tiene ${movs[0].total} movimiento(s) asociado(s)` 
      });
    }
    // Verificar cuenta corriente
    const { rows: cc } = await pool.query(
      'SELECT COUNT(*) as total FROM cc_contrapartes WHERE id_contraparte = $1',
      [req.params.id]
    );
    if (parseInt(cc[0].total) > 0) {
      return res.status(400).json({ 
        error: `No se puede eliminar — tiene movimientos en cuenta corriente` 
      });
    }
    await pool.query('DELETE FROM contrapartes WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
