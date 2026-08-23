const { pool } = require('../db');
const { ensureLiquidacionesGranosSchema } = require('./liquidacionesGranosSchema');

function n(value) { return Number(value || 0); }
function round(value) { return Math.round((n(value) + Number.EPSILON) * 10000) / 10000; }

function cuentaConcepto(tipo, operacion) {
  if (operacion === 'VENTA' && tipo === 'MERCADERIA') return '4.1.01.001';
  if (tipo === 'MERCADERIA') return '1.1.04.001';
  if (tipo === 'FLETE') return '5.1.01.001';
  if (tipo === 'COMISION') return '5.1.01.002';
  if (['REBAJA_CALIDAD','MERMA','SECADA','ZARANDA','ALMACENAJE','PARITARIA','FUMIGACION'].includes(tipo)) return '5.1.01.003';
  return '5.1.01.099';
}

function cuentaIva(alicuota, operacion) {
  const tasa = Math.abs(n(alicuota) - 10.5) < 0.0001 ? '101' : '102';
  return operacion === 'VENTA' ? `2.1.02.${tasa}` : `1.1.03.${tasa}`;
}

function cuentaImpuesto(item) {
  const tipo = String(item.tipo || '').toUpperCase();
  const caracter = String(item.caracter || '').toUpperCase();
  const sufrida = caracter === 'SUFRIDA';
  const detalle = `${item.regimen || ''} ${item.descripcion || ''} ${item.metadata?.impuestoBase || ''}`.toUpperCase();
  if (tipo === 'SISA' && detalle.includes('GANANC')) return sufrida ? '1.1.03.120' : '2.1.02.120';
  if (tipo.includes('IVA') || tipo === 'SISA') {
    if (!sufrida) return '2.1.02.110';
    return String(item.computabilidad || '').toUpperCase().includes('LIBRE') ? '1.1.03.111' : '1.1.03.110';
  }
  if (tipo === 'GANANCIAS') return sufrida ? '1.1.03.120' : '2.1.02.120';
  if (tipo === 'PERCEPCION_IIBB') return sufrida ? '1.1.03.131' : '2.1.02.131';
  if (tipo === 'IIBB') return sufrida ? '1.1.03.130' : '2.1.02.130';
  if (tipo === 'SELLOS') return sufrida ? '5.1.01.004' : '2.1.02.140';
  return '5.1.01.099';
}

async function generarAsientoLiquidacion(idLiquidacion, userId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureLiquidacionesGranosSchema(client);
    const { rows: liquidaciones } = await client.query('SELECT * FROM liquidaciones WHERE id=$1 FOR UPDATE', [idLiquidacion]);
    const liq = liquidaciones[0];
    if (!liq) throw new Error('Liquidacion no encontrada.');
    const operacion = String(liq.tipo || '').toUpperCase() === 'VENTA' ? 'VENTA' : 'COMPRA';
    const { rows: conceptos } = await client.query('SELECT * FROM liquidacion_conceptos WHERE id_liquidacion=$1 ORDER BY orden,id', [idLiquidacion]);
    const { rows: impuestos } = await client.query('SELECT * FROM liquidacion_impuestos WHERE id_liquidacion=$1 ORDER BY orden,id', [idLiquidacion]);
    if (!conceptos.length) throw new Error('La liquidacion no tiene conceptos contables.');
    const codes = [...new Set([
      ...(conceptos.flatMap(item => [cuentaConcepto(item.tipo, operacion), n(item.importe_iva) ? cuentaIva(item.alicuota_iva, operacion) : null])),
      ...impuestos.map(cuentaImpuesto), operacion === 'VENTA' ? '1.1.02.001' : '2.1.01.001'
    ].filter(Boolean))];
    const { rows: cuentas } = await client.query('SELECT id,codigo FROM plan_cuentas WHERE codigo=ANY($1)', [codes]);
    const cuentaId = new Map(cuentas.map(item => [item.codigo, item.id]));
    if (cuentaId.size !== codes.length) throw new Error('Faltan cuentas requeridas en el plan de cuentas.');

    const renglones = [];
    const add = (codigo, descripcion, debe, haber, refs = {}) => renglones.push({ codigo, descripcion, debe: round(debe), haber: round(haber), ...refs });
    for (const item of conceptos) {
      const signo = item.signo === 'RESTA' ? -1 : 1;
      const importe = n(item.importe_neto) * signo;
      if (importe) {
        if (operacion === 'VENTA') add(cuentaConcepto(item.tipo, operacion), item.descripcion, importe < 0 ? -importe : 0, importe > 0 ? importe : 0, { conceptoId: item.id });
        else add(cuentaConcepto(item.tipo, operacion), item.descripcion, importe > 0 ? importe : 0, importe < 0 ? -importe : 0, { conceptoId: item.id });
      }
      const iva = n(item.importe_iva) * signo;
      if (iva) {
        if (operacion === 'VENTA') add(cuentaIva(item.alicuota_iva, operacion), `IVA ${item.alicuota_iva}% - ${item.descripcion}`, iva < 0 ? -iva : 0, iva > 0 ? iva : 0, { conceptoId: item.id });
        else add(cuentaIva(item.alicuota_iva, operacion), `IVA ${item.alicuota_iva}% - ${item.descripcion}`, iva > 0 ? iva : 0, iva < 0 ? -iva : 0, { conceptoId: item.id });
      }
    }
    for (const item of impuestos) {
      const importe = n(item.importe);
      if (!importe) continue;
      const sufrida = item.caracter === 'SUFRIDA';
      add(cuentaImpuesto(item), item.descripcion, sufrida ? importe : 0, sufrida ? 0 : importe, { impuestoId: item.id });
    }
    const debeParcial = round(renglones.reduce((a, item) => a + item.debe, 0));
    const haberParcial = round(renglones.reduce((a, item) => a + item.haber, 0));
    const diferencia = round(haberParcial - debeParcial);
    if (diferencia > 0) add(operacion === 'VENTA' ? '1.1.02.001' : '2.1.01.001', `Saldo ${liq.nro_liquidacion}`, diferencia, 0);
    else if (diferencia < 0) add(operacion === 'VENTA' ? '1.1.02.001' : '2.1.01.001', `Saldo ${liq.nro_liquidacion}`, 0, -diferencia);
    const totalDebe = round(renglones.reduce((a, item) => a + item.debe, 0));
    const totalHaber = round(renglones.reduce((a, item) => a + item.haber, 0));
    if (Math.abs(totalDebe - totalHaber) > 0.0001) throw new Error('El asiento no balancea.');

    const numero = `LIQ-${idLiquidacion}`;
    const { rows: asientos } = await client.query(`INSERT INTO asientos_contables
      (numero,fecha,descripcion,origen_modulo,origen_id,estado,moneda,total_debe,total_haber,creado_por)
      VALUES($1,$2,$3,'LIQUIDACIONES_GRANOS',$4,'BORRADOR',$5,$6,$7,$8)
      ON CONFLICT(origen_modulo,origen_id) DO UPDATE SET descripcion=EXCLUDED.descripcion,
        total_debe=EXCLUDED.total_debe,total_haber=EXCLUDED.total_haber,updated_at=NOW()
      WHERE asientos_contables.estado='BORRADOR' RETURNING *`,
    [numero,liq.fecha_liquidacion,`Liquidacion ${liq.nro_liquidacion}`,idLiquidacion,liq.moneda || 'PESOS',totalDebe,totalHaber,userId]);
    if (!asientos[0]) throw new Error('El asiento ya fue confirmado y no puede regenerarse.');
    await client.query('DELETE FROM asiento_renglones WHERE id_asiento=$1', [asientos[0].id]);
    for (let i=0;i<renglones.length;i+=1) {
      const item=renglones[i];
      await client.query(`INSERT INTO asiento_renglones
        (id_asiento,orden,id_cuenta,id_contraparte,id_liquidacion,id_liquidacion_concepto,
         id_liquidacion_impuesto,descripcion,debe,haber,moneda)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [asientos[0].id,i,cuentaId.get(item.codigo),liq.id_contraparte,idLiquidacion,item.conceptoId || null,
        item.impuestoId || null,item.descripcion,item.debe,item.haber,liq.moneda || 'PESOS']);
    }
    await client.query('COMMIT');
    return { ...asientos[0], renglones: renglones.map(item => ({ ...item, cuenta: item.codigo })) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

module.exports = { cuentaConcepto, cuentaIva, cuentaImpuesto, generarAsientoLiquidacion };

