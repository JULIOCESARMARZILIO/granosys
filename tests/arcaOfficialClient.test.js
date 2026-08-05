describe('arcaOfficialClient XML helpers', () => {
  const client = require('../src/services/arcaOfficialClient');

  test('escapes XML safely', () => {
    expect(client._internal.xmlEscape(`<a x="1">&'</a>`))
      .toBe('&lt;a x=&quot;1&quot;&gt;&amp;&apos;&lt;/a&gt;');
  });

  test('extracts namespaced and escaped tags', () => {
    const xml = '<soap:Envelope><soap:Body><ns:loginCmsReturn>&lt;token&gt;abc&amp;123&lt;/token&gt;</ns:loginCmsReturn></soap:Body></soap:Envelope>';
    const login = client._internal.tag(xml, 'loginCmsReturn');
    expect(client._internal.tag(login, 'token')).toBe('abc&123');
  });

  test('extracts WSLPG document date without time', () => {
    expect(client._internal.fechaWslpg(
      '<autorizacion><fechaLiquidacion>2026-08-03T12:30:00</fechaLiquidacion></autorizacion>'
    )).toBe('2026-08-03');
  });

  test('extracts WSLPG business errors', () => {
    expect(client._internal.wslpgBusinessError(
      '<errores><error><codigo>600</codigo><descripcion>No existen datos</descripcion></error></errores>'
    )).toBe('600: No existen datos');
  });

  test('accepts a WSLPG PDF returned as base64 text', () => {
    const xml = '<liqConsReturn><coe>330231771067</coe><pdf>JVBERi0xLjQ=</pdf></liqConsReturn>';
    const result = client._internal.tag(xml, 'liqConsReturn');
    expect(client._internal.tag(result, 'pdf')).toBe('JVBERi0xLjQ=');
  });

  test('extracts the complete WSFE tax breakdown', () => {
    const payload = {
      rawXml: [
        '<ResultGet><ImpTotal>1215.50</ImpTotal><ImpTotConc>10</ImpTotConc>',
        '<ImpNeto>1000</ImpNeto><ImpOpEx>5</ImpOpEx><ImpTrib>0.50</ImpTrib><ImpIVA>200</ImpIVA>',
        '<Iva><AlicIva><Id>5</Id><BaseImp>1000</BaseImp><Importe>200</Importe></AlicIva></Iva>',
        '<Tributos><Tributo><Id>2</Id><Desc>PercepciÃ³n provincial</Desc><BaseImp>1000</BaseImp><Alic>0.05</Alic><Importe>0.50</Importe></Tributo></Tributos>',
        '</ResultGet>'
      ].join('')
    };
    expect(client._internal.detalleFiscalWsfe(payload)).toEqual({
      ImpTotal: 1215.5,
      ImpTotConc: 10,
      ImpNeto: 1000,
      ImpOpEx: 5,
      ImpTrib: 0.5,
      ImpIVA: 200,
      AlicIva: [{ Id: 5, BaseImp: 1000, Importe: 200 }],
      Tributos: [{
        Id: 2,
        Desc: 'PercepciÃ³n provincial',
        BaseImp: 1000,
        Alic: 0.05,
        Importe: 0.5
      }]
    });
  });

  test('treats WSFE credit notes as negative in IVA Ventas', () => {
    expect(client._internal.signoComprobanteWsfe(1)).toBe(1);
    expect(client._internal.signoComprobanteWsfe(3)).toBe(-1);
    expect(client._internal.signoComprobanteWsfe(8)).toBe(-1);
    expect(client._internal.signoComprobanteWsfe(203)).toBe(-1);
  });
});
