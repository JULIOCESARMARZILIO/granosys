const XLSX = require('xlsx');
const excelPath = "C:/Users/JCMARZILIO/Desktop/tabla de mermas humedad.xlsx";

try {
  const wb = XLSX.readFile(excelPath);
  wb.SheetNames.forEach(sheetName => {
    const sheet = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, {header: 1});
    data.forEach((row, rIdx) => {
      row.forEach((cell, cIdx) => {
        if (cell && String(cell).toLowerCase().includes('girasol')) {
          console.log(`Encontrado 'girasol' en la hoja '${sheetName}', fila ${rIdx}, col ${cIdx}:`, cell);
        }
      });
    });
  });
} catch(err) {
  console.error("Error:", err.message);
}
