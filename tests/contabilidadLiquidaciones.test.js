const { cuentaConcepto, cuentaIva, cuentaImpuesto } = require('../src/services/contabilidadLiquidaciones');

describe('imputacion contable de liquidaciones de granos', () => {
  test('separa IVA credito y debito por alicuota', () => {
    expect(cuentaIva(10.5, 'COMPRA')).toBe('1.1.03.101');
    expect(cuentaIva(21, 'COMPRA')).toBe('1.1.03.102');
    expect(cuentaIva(10.5, 'VENTA')).toBe('2.1.02.101');
    expect(cuentaIva(21, 'VENTA')).toBe('2.1.02.102');
  });

  test('separa retenciones sufridas, practicadas y libre disponibilidad', () => {
    expect(cuentaImpuesto({ tipo:'IVA', caracter:'PRACTICADA' })).toBe('2.1.02.110');
    expect(cuentaImpuesto({ tipo:'IVA', caracter:'SUFRIDA', computabilidad:'COMPUTABLE' })).toBe('1.1.03.110');
    expect(cuentaImpuesto({ tipo:'IVA', caracter:'SUFRIDA', computabilidad:'LIBRE_DISPONIBILIDAD' })).toBe('1.1.03.111');
    expect(cuentaImpuesto({ tipo:'GANANCIAS', caracter:'SUFRIDA' })).toBe('1.1.03.120');
    expect(cuentaImpuesto({ tipo:'IIBB', caracter:'PRACTICADA' })).toBe('2.1.02.130');
    expect(cuentaImpuesto({ tipo:'PERCEPCION_IIBB', caracter:'SUFRIDA' })).toBe('1.1.03.131');
    expect(cuentaImpuesto({ tipo:'SISA', caracter:'PRACTICADA', descripcion:'Retencion Ganancias SISA' })).toBe('2.1.02.120');
    expect(cuentaImpuesto({ tipo:'SELLOS', caracter:'SUFRIDA' })).toBe('5.1.01.004');
  });

  test('imputa flete y comision en cuentas propias', () => {
    expect(cuentaConcepto('FLETE', 'COMPRA')).toBe('5.1.01.001');
    expect(cuentaConcepto('COMISION', 'COMPRA')).toBe('5.1.01.002');
  });
});

