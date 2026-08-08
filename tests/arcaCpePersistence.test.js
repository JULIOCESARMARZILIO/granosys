jest.mock('pg');

describe('ARCA CPE persistence', () => {
  let client;
  let pool;

  beforeAll(async () => {
    const db = require('../src/db');
    pool = db.pool;
    await db.initDB();
    client = require('../src/services/arcaOfficialClient');
  });

  test('reimporting a CTG does not duplicate document, counterpart, plant or PDF', async () => {
    const input = {
      ctg: '10134183216',
      tipoCpe: 'AUTOMOTOR',
      fecha: '2026-08-07',
      payload: { cabecera: { nroCTG: '10134183216' } },
      intervinientes: [
        { rol: 'SOLICITANTE', cuit: '30710183992', razonSocial: 'INVERSIONES DEL SALADO S.A.' },
        { rol: 'DESTINO', cuit: '30506792165', razonSocial: 'CARGILL SACI' }
      ],
      plantas: [
        { rol: 'DESTINO', numero: '21047', cuitTitular: '30506792165', nombre: 'Pta COLON', localidad: 'COLON', provincia: 'BUENOS AIRES' }
      ],
      pdfBuffer: Buffer.from('%PDF-1.4\nCPE TEST\n%%EOF')
    };

    await client.importarCpeNormalizada(input);
    await client.importarCpeNormalizada(input);

    const documentCount = await pool.query("SELECT COUNT(*)::integer total FROM arca_official_documents WHERE fuente='WSCPE_CPE' AND external_key='10134183216'");
    const registryCount = await pool.query("SELECT COUNT(*)::integer total FROM arca_cpe_registry WHERE ctg='10134183216'");
    const participantCount = await pool.query("SELECT COUNT(*)::integer total FROM arca_cpe_participants WHERE ctg='10134183216'");
    const plantCount = await pool.query("SELECT COUNT(*)::integer total FROM arca_cpe_plants WHERE ctg='10134183216'");
    const fileCount = await pool.query('SELECT COUNT(*)::integer total FROM arca_official_files');
    const counterpartCount = await pool.query("SELECT COUNT(*)::integer total FROM contrapartes WHERE cuit IN ('30710183992','30506792165')");
    const locationCount = await pool.query("SELECT COUNT(*)::integer total FROM ubicaciones WHERE nro_planta='21047'");
    const eventCount = await pool.query("SELECT COUNT(*)::integer total FROM arca_cpe_import_events WHERE ctg='10134183216'");

    expect(documentCount.rows[0].total).toBe(1);
    expect(registryCount.rows[0].total).toBe(1);
    expect(participantCount.rows[0].total).toBe(2);
    expect(plantCount.rows[0].total).toBe(1);
    expect(fileCount.rows[0].total).toBe(1);
    expect(counterpartCount.rows[0].total).toBe(2);
    expect(locationCount.rows[0].total).toBe(1);
    expect(eventCount.rows[0].total).toBe(2);
  });
});

