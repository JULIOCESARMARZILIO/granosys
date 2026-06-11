const XLSX = require('xlsx');
const excelPath = "C:/Users/JCMARZILIO/Desktop/tabla de mermas humedad.xlsx";

try {
  const wb = XLSX.readFile(excelPath);
  const sheet = wb.Sheets["tabla de mermas"];
  const data = XLSX.utils.sheet_to_json(sheet, {header: 1});
  
  const tables = {
    soja: {},
    maiz: {},
    trigo: {}
  };

  for (let i = 2; i < data.length; i++) {
    const row = data[i];
    // Maiz (col 0, 1)
    if (row[0] !== undefined && row[1] !== undefined) {
      const hum = Number(row[0]).toFixed(1);
      tables.maiz[hum] = Number(row[1]);
    }
    // Soja (col 3, 4)
    if (row[3] !== undefined && row[4] !== undefined) {
      const hum = Number(row[3]).toFixed(1);
      tables.soja[hum] = Number(row[4]);
    }
    // Trigo (col 6, 7)
    if (row[6] !== undefined && row[7] !== undefined) {
      const hum = Number(row[6]).toFixed(1);
      tables.trigo[hum] = Number(row[7]);
    }
  }

  console.log("JSON_START");
  console.log(JSON.stringify(tables, null, 2));
  console.log("JSON_END");
} catch(err) {
  console.error("Error:", err.message);
}
