const { obtenerCoe, resumirDocumento, escalares } = require('../src/services/arcaLiquidationMaterializer');

describe('materializador de liquidaciones ARCA', () => {
  test('prioriza el COE del external_key', () => {
    expect(obtenerCoe({ external_key: '330231771067-1', payload: { coe: '331008719641' } }))
      .toBe('330231771067');
  });

  test('identifica primaria y conserva importes oficiales', () => {
    const result = resumirDocumento({
      id: 7,
      fuente: 'ARCA_LIQUIDACIONES_INTERACTIVAS',
      external_key: '330231771067',
      document_date: '2026-06-26',
      payload_hash: 'abc',
      payload: {
        fechaEmision: '26/06/2026',
        cuitLiquidador: '30710183992',
        cuitProductor: '20237118007',
        kilosLiquidados: '30.500,25',
        precioTonelada: 250000,
        importeIva: 80000,
        importeTotal: 1080000
      }
    });
    expect(result).toMatchObject({
      coe: '330231771067', clase: 'PRIMARIA', fecha: '2026-06-26',
      cuitLiquidador: '30710183992', cuitProductor: '20237118007',
      kilos: 30500.25, precio: 250000, importeIva: 80000, importeTotal: 1080000
    });
  });

  test('identifica secundaria y aplana todos los escalares', () => {
    const payload = { liquidacion: { coe: '331008719641', impuestos: [{ tipo: 'IVA', importe: 10 }] } };
    const result = resumirDocumento({ id: 8, fuente: 'WSLPG_LSG_COE', external_key: '',
      document_date: '2026-01-20', payload_hash: 'def', payload });
    expect(result.clase).toBe('SECUNDARIA');
    expect(result.coe).toBe('331008719641');
    expect(escalares(payload).map(item => item.path)).toEqual(expect.arrayContaining([
      'liquidacion.coe', 'liquidacion.impuestos[0].tipo', 'liquidacion.impuestos[0].importe'
    ]));
  });
});
