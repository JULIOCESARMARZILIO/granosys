const { pool } = require('../db');
const arcaOfficialClient = require('./arcaOfficialClient');

async function materializarDescargasDesdeCertificados({ userId = null } = {}) {
  await arcaOfficialClient.materializarCertificadosCtg();
  const { rows: movimientosFaltantes } = await pool.query(`
    SELECT DISTINCT cc.nro_ctg AS ctg
    FROM certificado_1116_ctgs cc
    LEFT JOIN movimientos m ON m.nro_ctg=cc.nro_ctg AND m.modalidad='FORMAL'
    WHERE cc.cpe_document_id IS NOT NULL AND m.id IS NULL
  `);
  if (movimientosFaltantes.length) {
    await arcaOfficialClient.materializarMovimientosCpe({
      desde: '2000-01-01',
      soloConfirmadas: true,
      ctgs: movimientosFaltantes.map(row => row.ctg)
    });
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS arca_certificado_descarga_audit (
      ctg VARCHAR(20) PRIMARY KEY,
      movimiento_id INTEGER REFERENCES movimientos(id) ON DELETE SET NULL,
      kilos_certificados NUMERIC(15,3),
      certificados JSONB NOT NULL DEFAULT '[]'::jsonb,
      estado VARCHAR(30) NOT NULL,
      motivo VARCHAR(200),
      procesado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const client = await pool.connect();
  const resultado = {
    revisadas: 0,
    descargadas: 0,
    yaDescargadas: 0,
    pendientes: 0,
    conflictos: 0,
    kilosAplicados: 0,
    pendientesPorMotivo: {},
    pendientesDetalle: []
  };
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('granosys:arca-certificados-descargas'))");
    const { rows } = await client.query(`
      SELECT cc.nro_ctg AS ctg, m.id AS movimiento_id, m.estado,
        m.peso_neto_llegada_kg, m.kg_liquidables,
        SUM(COALESCE(
          cc.kg_netos_acondicionados,
          CASE WHEN (SELECT COUNT(*) FROM certificado_1116_ctgs unico
                          WHERE unico.id_certificado_1116=cc.id_certificado_1116)=1
               THEN c.kilos_netos_acondicionados END
        ))::numeric AS kilos,
        jsonb_agg(DISTINCT jsonb_build_object('coe',c.coe,'certificado',c.numero_certificado)) AS certificados
      FROM certificado_1116_ctgs cc
      JOIN certificados_1116 c ON c.id=cc.id_certificado_1116
      LEFT JOIN movimientos m ON (m.id=cc.id_movimiento OR (cc.id_movimiento IS NULL AND m.nro_ctg=cc.nro_ctg)) AND m.modalidad='FORMAL'
      WHERE cc.cpe_document_id IS NOT NULL
      GROUP BY cc.nro_ctg,m.id,m.estado,m.peso_neto_llegada_kg,m.kg_liquidables
      ORDER BY cc.nro_ctg
    `);
    for (const row of rows) {
      resultado.revisadas += 1;
      const kilos = Number(row.kilos || 0);
      let estado = 'PENDIENTE';
      let motivo = null;
      if (!row.movimiento_id) motivo = 'MOVIMIENTO_FORMAL_NO_ENCONTRADO';
      else if (!Number.isFinite(kilos) || kilos <= 0) motivo = 'KILOS_CERTIFICADOS_FALTANTES';
      else if (['ANULADO','RECHAZADO'].includes(String(row.estado || '').toUpperCase())) motivo = 'MOVIMIENTO_NO_APLICABLE';
      else {
        const existente = row.kg_liquidables == null ? row.peso_neto_llegada_kg : row.kg_liquidables;
        if (existente != null && Math.abs(Number(existente) - kilos) > 0.001) {
          estado = 'CONFLICTO';
          motivo = 'KILOS_EXISTENTES_DIFIEREN_DEL_CERTIFICADO';
          const marker = 'Descarga respaldada por certificado ARCA con diferencia de kilos: movimiento ' +
            Number(existente).toFixed(3) + ' kg; certificado ' + kilos.toFixed(3) + ' kg.';
          await client.query(`
            UPDATE movimientos SET
              estado='DESCARGADO',
              observaciones=CASE WHEN COALESCE(observaciones,'') ILIKE '%' || $1 || '%'
                THEN observaciones ELSE CONCAT_WS(' ',NULLIF(observaciones,''),$1) END
            WHERE id=$2
          `, [marker, row.movimiento_id]);
          resultado.conflictos += 1;
          resultado.descargadas += 1;
        } else {
          const yaDescargado = String(row.estado || '').toUpperCase() === 'DESCARGADO';
          const marker = 'Descarga respaldada por certificado ARCA.';
          await client.query(`
            UPDATE movimientos SET
              estado='DESCARGADO',
              peso_neto_llegada_kg=COALESCE(peso_neto_llegada_kg,$1),
              kg_liquidables=COALESCE(kg_liquidables,$1),
              observaciones=CASE WHEN COALESCE(observaciones,'') ILIKE '%' || $2 || '%'
                THEN observaciones ELSE CONCAT_WS(' ',NULLIF(observaciones,''),$2) END
            WHERE id=$3
          `, [kilos, marker, row.movimiento_id]);
          estado = 'APLICADO';
          resultado.descargadas += 1;
          resultado.kilosAplicados += kilos;
          if (yaDescargado) resultado.yaDescargadas += 1;
        }
      }
      if (estado === 'PENDIENTE' || estado === 'CONFLICTO') {
        resultado.pendientesPorMotivo[motivo] = (resultado.pendientesPorMotivo[motivo] || 0) + 1;
        resultado.pendientesDetalle.push({
          ctg: row.ctg,
          movimientoId: row.movimiento_id || null,
          estado,
          motivo,
          kilosCertificados: kilos || null,
          kilosMovimiento: row.kg_liquidables == null ? row.peso_neto_llegada_kg : row.kg_liquidables,
          certificados: row.certificados || []
        });
      }
      if (estado === 'PENDIENTE') resultado.pendientes += 1;
      await client.query(`
        INSERT INTO arca_certificado_descarga_audit
          (ctg,movimiento_id,kilos_certificados,certificados,estado,motivo,procesado_por)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)
        ON CONFLICT(ctg) DO UPDATE SET movimiento_id=EXCLUDED.movimiento_id,
          kilos_certificados=EXCLUDED.kilos_certificados,certificados=EXCLUDED.certificados,
          estado=EXCLUDED.estado,motivo=EXCLUDED.motivo,procesado_por=EXCLUDED.procesado_por,updated_at=NOW()
      `, [row.ctg,row.movimiento_id,kilos||null,JSON.stringify(row.certificados||[]),estado,motivo,userId]);
    }
    await client.query('COMMIT');
    return resultado;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { materializarDescargasDesdeCertificados };

