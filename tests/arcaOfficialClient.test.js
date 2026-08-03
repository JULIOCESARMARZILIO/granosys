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
});
