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

  test.each([
    ['330231771067', 'LPG', 'liqConsXCoeReq', 'liqConsReturn'],
    ['331008719641', 'LSG', 'lsgConsultarXCoeReq', 'oReturn'],
    ['332023497375', 'CERTIFICACION', 'cgConsultarXCoeReq', 'oReturn']
  ])('routes COE %s through the official %s query', (coe, id, consultar, resultTag) => {
    const { definition, requestXml } = client._internal.solicitudWslpgPorCoe(coe);
    expect(definition).toEqual(expect.objectContaining({ id, consultar, resultTag, coe }));
    expect(requestXml).toBe(`<coe>${coe}</coe><pdf>S</pdf>`);
  });

  test('rejects COE prefixes outside the official WSLPG document families', () => {
    expect(() => client._internal.solicitudWslpgPorCoe('333000000001'))
      .toThrow('no corresponde a LPG, LSG ni certificación');
  });

  test('builds the official independent WSLPG adjustment request', () => {
    expect(client._internal.solicitudAjusteWslpgPorCoe('330100007082')).toEqual({
      coe: '330100007082',
      operation: 'ajusteXCoeConsReq',
      resultTag: 'ajusteConsReturn',
      payloadTag: 'ajusteUnificado',
      requestXml: '<coe>330100007082</coe><pdf>S</pdf>'
    });
    expect(() => client._internal.solicitudAjusteWslpgPorCoe('331008719641'))
      .toThrow('COE de ajuste WSLPG invalido');
  });

  test('parses adjustment data and PDF without using the liquidation response', () => {
    const xml = [
      '<ajusteXcoeConsResp><ajusteConsReturn><ajusteUnificado>',
      '<ptoEmision>40</ptoEmision><nroOrden>21</nroOrden><nroContrato>100001052</nroContrato>',
      '<coeAjustado>330100000001</coeAjustado><ajusteCredito><fechaLiquidacion>2026-06-26</fechaLiquidacion></ajusteCredito>',
      '<coe>330100007082</coe><estado>AC</estado></ajusteUnificado>',
      '<pdf>JVBERi0xLjQ=</pdf></ajusteConsReturn></ajusteXcoeConsResp>'
    ].join('');
    expect(client._internal.parsearAjusteWslpg(xml, '330100007082')).toEqual(expect.objectContaining({
      tipoDocumento: 'LPG_AJUSTE',
      fuente: 'WSLPG_AJUSTE_COE',
      coe: '330100007082',
      coeAjustado: '330100000001',
      fecha: '2026-06-26',
      ptoEmision: 40,
      nroOrden: 21,
      nroContrato: '100001052',
      pdfBase64: 'JVBERi0xLjQ='
    }));
  });

  test('validates and decodes the official WSLPG PDF', () => {
    expect(client._internal.decodificarPdfWslpg('JVBERi0xLjQ=').subarray(0, 5).toString('ascii'))
      .toBe('%PDF-');
    expect(() => client._internal.decodificarPdfWslpg('bm8gZXMgcGRm'))
      .toThrow('PDF WSLPG inválido');
  });

  test('removes the PDF body from the JSON audit payload', () => {
    expect(client._internal.payloadOficialSinPdf({
      coe: '331008719641',
      pdfBase64: 'JVBERi0xLjQ=',
      rawXml: '<oReturn><coe>331008719641</coe><pdf>JVBERi0xLjQ=</pdf></oReturn>'
    })).toEqual({
      coe: '331008719641',
      rawXml: '<oReturn><coe>331008719641</coe><pdf>[ALMACENADO_COMO_ARCHIVO]</pdf></oReturn>'
    });
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

  test('splits the historical WSCPE query into inclusive 3-day ranges', () => {
    expect(client._internal.rangosWscpe('2026-02-01', '2026-02-08')).toEqual([
      { desde: '2026-02-01', hasta: '2026-02-03' },
      { desde: '2026-02-04', hasta: '2026-02-06' },
      { desde: '2026-02-07', hasta: '2026-02-08' }
    ]);
  });

  test('recognizes only the official CN state as confirmed', () => {
    expect(client._internal.esEstadoConfirmadoCpe('CN')).toBe(true);
    expect(client._internal.esEstadoConfirmadoCpe(' cn ')).toBe(true);
    expect(client._internal.esEstadoConfirmadoCpe('AC')).toBe(false);
    expect(client._internal.esEstadoConfirmadoCpe('AN')).toBe(false);
  });

  test('extracts the official state from the persisted WSCPE payload', () => {
    expect(client._internal.estadoCpeDesdePayload({
      rawXml: '<respuesta><cabecera><estado>CN</estado></cabecera></respuesta>'
    })).toBe('CN');
  });

  test.each([
    ['10134183216', 'PRODUCTOR', 'PROPIA'],
    ['10234183216', 'PLANTA', 'ACOPIO'],
    ['99934183216', null, null]
  ])('classifies CTG %s by its official origin prefix', (ctg, tipoOrigenCpe, origenProduccion) => {
    expect(client._internal.clasificarOrigenCtg(ctg)).toEqual({ tipoOrigenCpe, origenProduccion });
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

  test('uses the exact official derivative as the CPEDG product', () => {
    expect(client.productoCpeOficial('AUTOMOTOR_DG', {
      codGrano: '23',
      codDerivadoGranario: '145'
    })).toEqual(expect.objectContaining({
      nombre: 'Expeller de soja',
      codigo: 'ARCA-DG-145',
      tipoProducto: 'SUBPRODUCTO',
      esDerivado: true
    }));
  });

  test('does not label an unknown CPEDG derivative as soybean grain', () => {
    expect(client.productoCpeOficial('AUTOMOTOR_DG', {
      codGrano: '23',
      codDerivadoGranario: '999'
    })).toEqual(expect.objectContaining({
      nombre: null,
      codigo: 'ARCA-DG-999',
      tipoProducto: 'SUBPRODUCTO',
      esDerivado: true
    }));
  });

  test('keeps the base grain only for ordinary CPE', () => {
    expect(client.productoCpeOficial('AUTOMOTOR', {
      codGrano: '23'
    })).toEqual(expect.objectContaining({
      nombre: 'Soja',
      codigo: 'ARCA-GR-23',
      tipoProducto: 'GRANO',
      esDerivado: false
    }));
  });

  test.each([
    ['101', 'Aceite crudo de girasol'],
    ['102', 'Aceite crudo de maíz'],
    ['103', 'Aceite crudo de soja'],
    ['144', 'Expeller de girasol'],
    ['187', 'Maíz quebrado-partido'],
    ['199', 'Pellets de girasol'],
    ['200', 'Pellets de maíz'],
    ['202', 'Pellets de sorgo'],
    ['226', 'Trigo quebrado-partido'],
    ['287', 'Pellets de cebada']
  ])('maps official CPEDG code %s across all crops', (codigo, nombre) => {
    expect(client.productoCpeOficial('AUTOMOTOR_DG', {
      codDerivadoGranario: codigo
    })).toEqual(expect.objectContaining({
      nombre,
      codigo: `ARCA-DG-${codigo}`,
      tipoProducto: 'SUBPRODUCTO',
      esDerivado: true
    }));
  });

  test.each([
    ['Cáscara de soja', 'Cáscara de soja'],
    ['Aceite de soja', 'Aceite de soja'],
    ['Harina de soja', 'Harina de soja'],
    ['Pellets de cáscara de soja', 'Pellets de cáscara de soja']
  ])('preserves the specific ARCA derivative description %s', (descripcion, nombre) => {
    expect(client.productoCpeOficial('AUTOMOTOR_DG', {
      codGrano: '23',
      codDerivadoGranario: '201'
    }, { observaciones: descripcion })).toEqual(expect.objectContaining({
      nombre,
      tipoProducto: 'SUBPRODUCTO'
    }));
  });

});
