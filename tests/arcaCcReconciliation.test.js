jest.mock('pg');

describe('ARCA to current-account reconciliation', () => {
  let pool;
  let client;
  let documentId;
  let userId;

  beforeAll(async () => {
    const db = require('../src/db');
    pool = db.pool;
    await db.initDB();
    client = require('../src/services/arcaOfficialClient');
    await client.obtenerResumenDocumentos();
    const suffix = Date.now();
    const user = await pool.query(`
      INSERT INTO usuarios(usuario,contrasena,nombre,rol)
      VALUES($1,'test','Auditor ARCA','ADMIN') RETURNING id
    `, [`arca_cc_${suffix}`]);
    userId = user.rows[0].id;
    await pool.query(`
      INSERT INTO contrapartes
        (codigo_interno,cuit,razon_social,tipo_contraparte,canal_operacion)
      VALUES($1,'30709999991','Cliente fiscal de prueba','COMPRADOR','FORMAL')
    `, [`ARCA-${suffix}`]);
    const document = await pool.query(`
      INSERT INTO arca_official_documents
        (fuente,external_key,document_date,payload,payload_hash)
      VALUES('WSFE_EMITIDA',$1,'2026-08-01',$2::jsonb,$3)
      RETURNING id
    `, [
      `test:${suffix}`,
      JSON.stringify({
        CbteTipo: 1,
        PtoVta: 4,
        CbteDesde: suffix,
        DocNro: '30709999991',
        ImpTotal: '1210.00',
        ImpNeto: '1000.00',
        ImpIVA: '210.00',
        ImpTotConc: '0',
        ImpOpEx: '0',
        ImpTrib: '0',
        MonId: 'PES'
      }),
      String(suffix).padEnd(64, '0').slice(0, 64)
    ]);
    documentId = document.rows[0].id;
  });

  test('proposes without writing and creates only after human decision', async () => {
    const pending = await client.listarConciliacionesCuentaCorriente({
      desde: '2026-08-01',
      hasta: '2026-08-01'
    });
    const proposal = pending.conciliaciones.find(item => Number(item.document_id) === Number(documentId));
    expect(proposal.recomendacion).toBe('REVISAR_CREACION');

    const before = await pool.query(
      "SELECT COUNT(*)::integer AS total FROM cc_contrapartes WHERE tipo_movimiento='DOCUMENTO_ARCA'"
    );
    const decision = await client.decidirConciliacionCuentaCorriente({
      documentId,
      decision: 'CREAR_MOVIMIENTO',
      userId
    });
    expect(decision.estado).toBe('CREADO');

    const movement = await pool.query('SELECT * FROM cc_contrapartes WHERE id=$1', [decision.cc_movimiento_id]);
    expect(Number(movement.rows[0].debe)).toBe(1210);
    expect(Number(movement.rows[0].haber)).toBe(0);
    expect(movement.rows[0].modalidad).toBe('FORMAL');

    const after = await pool.query(
      "SELECT COUNT(*)::integer AS total FROM cc_contrapartes WHERE tipo_movimiento='DOCUMENTO_ARCA'"
    );
    expect(after.rows[0].total).toBe(before.rows[0].total + 1);

    await expect(client.decidirConciliacionCuentaCorriente({
      documentId,
      decision: 'CREAR_MOVIMIENTO',
      userId
    })).rejects.toThrow('ya fue conciliado');
  });
});
