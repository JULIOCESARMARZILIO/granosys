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
});
