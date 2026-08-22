const { _internal } = require('../src/services/arcaOfficialClient');

describe('detalleLiquidacionWslpg', () => {
  test('normaliza importes y conserva los campos oficiales sin exponer secretos', () => {
    const detalle = _internal.detalleLiquidacionWslpg({
      coe: '331000000001', tipoOperacion: 'Liquidacion primaria',
      datosGenerales: {
        cuitLiquidador: '30710183992', razonSocialLiquidador: 'INVERSIONES DEL SALADO S.A.',
        cuitProductor: '30111111118', razonSocialProductor: 'PRODUCTOR PRUEBA',
        descripcionGrano: 'SOJA', kilosNetos: '25.000,000', precioTonelada: '200.000,00'
      },
      importes: {
        importeIva: '525.000,00', impuestoSellos: '10.000,00',
        retencionGanancias: '50.000,00', retencionIva: '350.000,00', importeTotal: '5.115.000,00'
      },
      token: 'NO-DEBE-SALIR', rawXml: '<privado/>'
    });
    expect(detalle.coe).toBe('331000000001');
    expect(detalle.toneladas).toBe(25);
    expect(detalle.precioTonelada).toBe(200000);
    expect(detalle.iva).toBe(525000);
    expect(detalle.sellado).toBe(10000);
    expect(detalle.retencionGanancias).toBe(50000);
    expect(detalle.retencionIva).toBe(350000);
    expect(detalle.camposOficiales.some(item => /token|rawXml/i.test(item.campo))).toBe(false);
  });

  test('lee el XML oficial de una 1116 C y conserva participantes, items e impuestos repetidos', () => {
    const detalle = _internal.detalleLiquidacionWslpg({
      tipoDocumento: 'LPG',
      rawXml: [
        '<liqConsReturn><coe>330231771067</coe><tipoOperacion>Consignación de granos</tipoOperacion>',
        '<estado>ACTIVA</estado><liquidador><cuit>30710183992</cuit><razonSocial>INVERSIONES DEL SALADO S.A.</razonSocial></liquidador>',
        '<vendedor><cuit>20237118007</cuit><razonSocial>PRODUCTOR PRUEBA</razonSocial></vendedor>',
        '<items><item><descripcionGrano>SOJA</descripcionGrano><campania>2025/2026</campania><kilosNetos>25000</kilosNetos><precioTonelada>200000</precioTonelada><importeBruto>5000000</importeBruto></item></items>',
        '<impuestos><iva><descripcion>IVA 10,5%</descripcion><baseImponible>5000000</baseImponible><alicuota>10.5</alicuota><importe>525000</importe></iva>',
        '<retencion><descripcion>Retención IVA</descripcion><alicuota>7</alicuota><importe>350000</importe></retencion>',
        '<retencion><descripcion>Retención Ganancias</descripcion><alicuota>2</alicuota><importe>100000</importe></retencion></impuestos>',
        '<importeTotal>5075000</importeTotal><pdf>JVBERi0xLjQ=</pdf><token>SECRETO</token></liqConsReturn>'
      ].join('')
    });
    expect(detalle.coe).toBe('330231771067');
    expect(detalle.familiaDocumento).toBe('Liquidación primaria de granos (LPG)');
    expect(detalle.tipoFormularioHistorico).toBe('1116 C / Consignación');
    expect(detalle.participantes).toEqual(expect.arrayContaining([
      expect.objectContaining({ cuit: '30710183992' }),
      expect.objectContaining({ cuit: '20237118007' })
    ]));
    expect(detalle.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ producto: 'SOJA', kilos: 25000, precioTonelada: 200000 })
    ]));
    expect(detalle.conceptosImpositivos).toHaveLength(3);
    expect(detalle.conceptosImpositivos).toEqual(expect.arrayContaining([
      expect.objectContaining({ concepto: 'IVA 10,5%', baseImponible: 5000000, alicuota: 10.5, importe: 525000 }),
      expect.objectContaining({ concepto: 'Retención IVA', alicuota: 7, importe: 350000 }),
      expect.objectContaining({ concepto: 'Retención Ganancias', importe: 100000 })
    ]));
    expect(detalle.camposOficiales.some(item => /pdf|token/i.test(item.campo))).toBe(false);
    expect(detalle.camposOficiales.some(item => item.valor === 'JVBERi0xLjQ=' || item.valor === 'SECRETO')).toBe(false);
  });
});

