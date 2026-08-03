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
});
