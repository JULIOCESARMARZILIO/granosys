const XLSX = require('xlsx');
const excelPath = "C:/Users/JCMARZILIO/Desktop/tabla de mermas humedad.xlsx";

try {
  const wb = XLSX.readFile(excelPath);
  const sheet = wb.Sheets["tabla de mermas"];
  const data = XLSX.utils.sheet_to_json(sheet, {header: 1});
  
  const columns = {
    MAIZ: { hums: [], mermas: [] },
    SOJA: { hums: [], mermas: [] },
    TRIGO: { hums: [], mermas: [] }
  };

  // Fila 0: headers grandes
  // Fila 1: Humedad, Merma, etc.
  for (let i = 2; i < data.length; i++) {
    const row = data[i];
    if (row[0] !== undefined && row[1] !== undefined) {
      columns.MAIZ.hums.push(Number(row[0]));
      columns.MAIZ.mermas.push(Number(row[1]));
    }
    if (row[3] !== undefined && row[4] !== undefined) {
      columns.SOJA.hums.push(Number(row[3]));
      columns.SOJA.mermas.push(Number(row[4]));
    }
    if (row[6] !== undefined && row[7] !== undefined) {
      columns.TRIGO.hums.push(Number(row[6]));
      columns.TRIGO.mermas.push(Number(row[7]));
    }
  }

  ['MAIZ', 'SOJA', 'TRIGO'].forEach(crop => {
    const info = columns[crop];
    console.log(`${crop}:`);
    console.log(`  Cantidad filas: ${info.hums.length}`);
    console.log(`  Humedad: min=${info.hums[0]}, max=${info.hums[info.hums.length - 1]}`);
    console.log(`  Merma: min=${info.mermas[0]}%, max=${info.mermas[info.mermas.length - 1]}%`);
  });
} catch(err) {
  console.error("Error:", err.message);
}
