const { extractKg, findKgCombination, baseEvidence } = require('../src/services/arcaTraceability');

describe('ARCA certificate traceability', () => {
  test('extracts kilograms from nested official payloads', () => {
    expect(extractKg({ carta: { pesoNeto: '30.500,25' } })).toBe(30500.25);
  });

  test('finds a group of CPEs whose kilograms reconcile a certificate', () => {
    const result = findKgCombination([
      { ctg: '1', kg: 30000 }, { ctg: '2', kg: 35000 }, { ctg: '3', kg: 12000 }
    ], 65000, 50);
    expect(result.items.map(item => item.ctg).sort()).toEqual(['1', '2']);
    expect(result.sum).toBe(65000);
  });

  test('scores CUIT, species, campaign and close dates as evidence', () => {
    const evidence = baseEvidence(
      { cuit_productor: '30-71018399-2', especie_nombre: 'Soja', campana_desc: '2025/2026', fecha_emision: '2026-03-05', datos_raw: { nroPlanta: '21047' } },
      { participant_cuits: ['30710183992'], plant_numbers: ['21047'], document_date: '2026-03-03', payload: { especie: 'SOJA', campana: '2025/2026' } }
    );
    expect(evidence.score).toBe(95);
    expect(evidence.cuitMatch).toBe(true);
    expect(evidence.plantMatch).toBe(true);
  });
});

