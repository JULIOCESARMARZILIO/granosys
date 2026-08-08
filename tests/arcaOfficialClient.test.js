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
        '<Tributos><Tributo><Id>2</Id><Desc>Percepción provincial</Desc><BaseImp>1000</BaseImp><Alic>0.05</Alic><Importe>0.50</Importe></Tributo></Tributos>',
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
        Desc: 'Percepción provincial',
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

  test('normalizes an official Padrón A13 person response', () => {
    const xml = '<Envelope><Body><getPersonaResponse><personaReturn><persona><idPersona>30701843742</idPersona><tipoPersona>JURIDICA</tipoPersona><estadoClave>ACTIVO</estadoClave><razonSocial>EMPRESA DE PRUEBA SA</razonSocial><domicilio><tipoDomicilio>FISCAL</tipoDomicilio><direccion>RUTA 5 KM 1</direccion><localidad>CHIVILCOY</localidad><codigoPostal>6620</codigoPostal><descripcionProvincia>BUENOS AIRES</descripcionProvincia></domicilio></persona></personaReturn></getPersonaResponse></Body></Envelope>';
    const result = client._internal.parsearPersonaPadronA13(xml);
    expect(result.datosGenerales.razonSocial).toBe('EMPRESA DE PRUEBA SA');
    expect(result.datosGenerales.domicilioFiscal.localidad).toBe('CHIVILCOY');
  });

  test('normalizes CUIT and plant identifiers used by CPE deduplication', () => {
    expect(client._internal.normalizarCuit('30-71018399-2')).toBe('30710183992');
    expect(client._internal.normalizarCuit('123')).toBeNull();
    expect(client._internal.normalizarNumeroPlanta('00021047')).toBe('21047');
  });

  test('extracts CPE participants and plants without repeating role/CUIT', () => {
    const xml = [
      '<respuesta><cabecera><cuitSolicitante>30710183992</cuitSolicitante><nroCTG>10134183216</nroCTG></cabecera>',
      '<origen><planta>00014229</planta><cuitTitularPlanta>30710183992</cuitTitularPlanta><domicilioOrigen>RUTA 5</domicilioOrigen></origen>',
      '<intervinientes><cuitCorredorVentaPrimaria>30701843742</cuitCorredorVentaPrimaria></intervinientes>',
      '<destino><cuit>30506792165</cuit><planta>21047</planta><domicilioDestino>COLON</domicilioDestino></destino>',
      '<transporte><cuitTransportista>30705555551</cuitTransportista><cuitChofer>20233381781</cuitChofer></transporte></respuesta>'
    ].join('');
    expect(client._internal.extraerIntervinientesCpe(xml)).toEqual(expect.arrayContaining([
      expect.objectContaining({ rol: 'SOLICITANTE', cuit: '30710183992' }),
      expect.objectContaining({ rol: 'CORREDOR_VENTA_PRIMARIA', cuit: '30701843742' }),
      expect.objectContaining({ rol: 'TRANSPORTISTA', cuit: '30705555551' }),
      expect.objectContaining({ rol: 'CHOFER', cuit: '20233381781' })
    ]));
    expect(client._internal.extraerPlantasCpe(xml)).toEqual(expect.arrayContaining([
      expect.objectContaining({ rol: 'ORIGEN', numero: '14229' }),
      expect.objectContaining({ rol: 'DESTINO', numero: '21047' })
    ]));
  });

  test('converts an official WSCPE response to a complete JSON tree', () => {
    expect(client._internal.xmlToObject('<respuesta><cabecera><nroCTG>10134183216</nroCTG></cabecera><pdf>JVBERi0=</pdf></respuesta>'))
      .toEqual({ respuesta: { cabecera: { nroCTG: '10134183216' }, pdf: 'JVBERi0=' } });
  });

  test('maps official CPE roles to existing counterpart types', () => {
    expect(client._internal.tipoContrapartePorRol('TRANSPORTISTA')).toBe('TRANSPORTISTA');
    expect(client._internal.tipoContrapartePorRol('CORREDOR VENTA PRIMARIA')).toBe('CORREDOR');
    expect(client._internal.tipoContrapartePorRol('PRODUCTOR')).toBe('PRODUCTOR');
    expect(client._internal.tipoContrapartePorRol('DESTINATARIO')).toBe('COMPRADOR');
  });

  test('splits the historical WSCPE query into inclusive 31-day ranges', () => {
    expect(client._internal.rangosWscpe('2026-02-01', '2026-04-05')).toEqual([
      { desde: '2026-02-01', hasta: '2026-03-03' },
      { desde: '2026-03-04', hasta: '2026-04-03' },
      { desde: '2026-04-04', hasta: '2026-04-05' }
    ]);
  });

  test('preserves the proven WSCPE target and includes ARCA domain compatibility', () => {
    const targets = client._internal.wscpeTargets(true);
    expect(targets[0]).toEqual({
      url: 'https://cpea-ws.afip.gob.ar/wscpe/services/soap',
      namespace: 'https://serviciosjava.afip.gob.ar/wscpe/'
    });
    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: 'https://cpea-ws.arca.gob.ar/wscpe/services/soap' })
    ]));
  });
});
