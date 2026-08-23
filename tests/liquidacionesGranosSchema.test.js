const {
  validarAlicuotaIva,
  normalizarConcepto,
  calcularTotales
} = require('../src/services/liquidacionesGranosSchema');

describe('liquidaciones de granos profesionales', () => {
  test('discrimina mercaderia al 10,5% y flete al 21%', () => {
    const totales = calcularTotales([
      { tipo: 'MERCADERIA', importeNeto: 1000000, alicuotaIva: 10.5 },
      { tipo: 'FLETE', importeNeto: 100000, alicuotaIva: 21 }
    ]);
    expect(totales.neto).toBe(1100000);
    expect(totales.iva105).toBe(105000);
    expect(totales.iva21).toBe(21000);
    expect(totales.total).toBe(1226000);
  });

  test('resta retenciones SISA sin mezclar bases de IVA', () => {
    const totales = calcularTotales(
      [{ tipo: 'MERCADERIA', importeNeto: 1000000, alicuotaIva: 10.5 }],
      [{ tipo: 'SISA', importe: 70000, signo: 'RESTA' }]
    );
    expect(totales.iva).toBe(105000);
    expect(totales.tributos).toBe(-70000);
    expect(totales.total).toBe(1035000);
  });

  test('admite exento y rechaza alicuotas imposibles', () => {
    expect(normalizarConcepto({ tipo: 'SELLADO', importeNeto: 500, alicuotaIva: 0 }).importeIva).toBe(0);
    expect(() => validarAlicuotaIva(101)).toThrow('entre 0 y 100');
  });
});

