const { extractCertificate, extractLiquidationApplication, extractLiquidationApplications } = require('../src/services/arcaCertificateExtractor');

describe('ARCA certificate extraction', () => {
  test('extracts one certificate account with its CPE list and both kilogram totals', () => {
    const result = extractCertificate({
      certificado: {
        coe: '123456789012',
        numeroCertificado: 'CERT-42',
        cuitProductor: '30-71018399-2',
        cuitComprador: '30-50679216-5',
        especie: 'Soja',
        campana: '2025/2026',
        kilosBrutos: '60.300,000',
        kilosNetosAcondicionados: '59.550,000',
        mermaHumedadKg: '600',
        otrasMermasKg: '150',
        humedad: '13,8',
        materiaExtrana: '1,2',
        proteina: '34,5',
        cartas: [{ nroCTG: '10134183216' }, { nroCTG: '10134183217' }]
      }
    });
    expect(result.coe).toBe('123456789012');
    expect(result.producerCuit).toBe('30710183992');
    expect(result.buyerCuit).toBe('30506792165');
    expect(result.grossKg).toBe(60300);
    expect(result.conditionedKg).toBe(59550);
    expect(result.totalLossKg).toBe(750);
    expect(result.ctgs).toEqual(['10134183216', '10134183217']);
    expect(result.observations).toEqual([]);
    expect(result.qualities).toEqual(expect.arrayContaining([
      {parameter:'HUMEDAD',value:13.8,unit:'%'},
      {parameter:'MATERIA_EXTRANA',value:1.2,unit:'%'},
      {parameter:'PROTEINA',value:34.5,unit:'%'}
    ]));
    expect(result).not.toHaveProperty('plant');
  });

  test('extracts a liquidation application against the certificate COE with both kilograms', () => {
    const result = extractLiquidationApplication({
      liquidacion: {
        coe: '998877665544',
        coeCertificadoDeposito: '123456789012',
        kilosBrutosAplicados: '30.000',
        kilosNetosAcondicionadosAplicados: '29.650'
      }
    }, { document_date: '2026-08-18' });
    expect(result.certificateCoe).toBe('123456789012');
    expect(result.liquidationCoe).toBe('998877665544');
    expect(result.grossKg).toBe(30000);
    expect(result.conditionedKg).toBe(29650);
    expect(result.observations).toEqual([]);
  });

  test('marks incomplete official data for review instead of inventing values', () => {
    const result = extractCertificate({ coe: '123456789012' });
    expect(result.observations).toEqual(expect.arrayContaining([
      'PRODUCTOR_SIN_CUIT', 'COMPRADOR_CERTIFICADOR_SIN_CUIT',
      'SIN_CTG', 'SIN_KILOS_BRUTOS', 'SIN_KILOS_NETOS_ACONDICIONADOS'
    ]));
  });

  test('preserves Gemini PDF truck detail and broad certificate roles', () => {
    const result = extractCertificate({ geminiCertificateExtraction: {
      coe: '123456789012', productor_cuit: '30-71018399-2', comprador_cuit: '30-50679216-5',
      especie: 'Soja', campana: '2025/2026', kilos_brutos_certificados: 60300,
      kilos_netos_acondicionados: 59550,
      camiones: [{ ctg: '10134183216', kilos_netos_descargados: 30000,
        kilos_netos_acondicionados: 29650, merma_humedad_kg: 250, merma_calidad_kg: 100,
        humedad_pct: 14.1 }],
      calidades: [{ parametro: 'Proteína', valor: 34.5, unidad: '%', observacion: '' }]
    }});
    expect(result.ctgs).toEqual(['10134183216']);
    expect(result.trucks[0]).toMatchObject({ ctg:'10134183216', unloadedNetKg:30000,
      conditionedKg:29650, humidityLossKg:250, qualityLossKg:100, humidityPct:14.1 });
    expect(result.qualities).toEqual([{ parameter:'PROTEINA', value:34.5, unit:'%' }]);
    expect(result.observations).toEqual([]);
  });

  test('extracts every certificate application from one liquidation', () => {
    const results = extractLiquidationApplications({
      liquidacion: {
        coe: '998877665544',
        certificados: [
          { coeCertificadoDeposito: '123456789012', kilosBrutosAplicados: '20.000', kilosNetosAcondicionadosAplicados: '19.700' },
          { coeCertificadoDeposito: '123456789013', kilosBrutosAplicados: '10.000', kilosNetosAcondicionadosAplicados: '9.850' }
        ]
      }
    }, { document_date: '2026-08-18' });
    expect(results).toHaveLength(2);
    expect(results.map(item => item.certificateCoe)).toEqual(['123456789012', '123456789013']);
    expect(results.map(item => item.grossKg)).toEqual([20000, 10000]);
    expect(results.map(item => item.conditionedKg)).toEqual([19700, 9850]);
  });

  test('extracts certificate applications from the official liquidation XML', () => {
    const results = extractLiquidationApplications({
      coe: '998877665544',
      rawXml: '<liquidacion><certificados><certificado><nroCertificadoDeposito>123456789012</nroCertificadoDeposito><pesoNeto>19.700</pesoNeto></certificado><certificado><nroCertificadoDeposito>123456789013</nroCertificadoDeposito><pesoNeto>9.850</pesoNeto></certificado></certificados></liquidacion>'
    }, { document_date: '2026-08-18' });
    expect(results).toHaveLength(2);
    expect(results.map(item => item.certificateCoe)).toEqual(['123456789012', '123456789013']);
    expect(results.map(item => item.conditionedKg)).toEqual([19700, 9850]);
    expect(results.every(item => item.observations.length === 0)).toBe(true);
  });
});
