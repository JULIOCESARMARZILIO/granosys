const arcaOfficialClient = require('../src/services/arcaOfficialClient');

describe('reporte Excel de intervinientes CPE', () => {
  const { seleccionarPersonaReporte } = arcaOfficialClient._internal;

  test('prioriza el rol COMPRADOR cuando ARCA lo informa', () => {
    const personas = [
      { rol: 'DESTINATARIO', cuit: '30111111111' },
      { rol: 'COMPRADOR', cuit: '30222222222' }
    ];
    expect(seleccionarPersonaReporte(personas, ['COMPRADOR', 'DESTINATARIO'])).toEqual(personas[1]);
  });

  test('usa el destinatario como referencia si no existe COMPRADOR', () => {
    const personas = [{ rol: 'DESTINATARIO', cuit: '30111111111' }];
    expect(seleccionarPersonaReporte(personas, ['COMPRADOR', 'DESTINATARIO'])).toEqual(personas[0]);
  });

  test('no inventa una persona si ninguno de los roles está presente', () => {
    const personas = [{ rol: 'TRANSPORTISTA', cuit: '30333333333' }];
    expect(seleccionarPersonaReporte(personas, ['COMPRADOR', 'DESTINATARIO'])).toBeNull();
  });
});
