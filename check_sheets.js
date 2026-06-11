const XLSX = require('xlsx');
const excelPath = "C:/Users/JCMARZILIO/Desktop/tabla de mermas humedad.xlsx";

try {
  const wb = XLSX.readFile(excelPath);
  console.log("Hojas del Excel:", wb.SheetNames);
  const sheet = wb.Sheets["tabla de mermas"];
  if (!sheet) {
    console.error("No se encontró la hoja 'tabla de mermas'");
    process.exit(1);
  }
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  console.log("Número de filas:", data.length);
  // Imprimir las primeras 10 filas de manera estructurada
  for (let i = 0; i < Math.min(15, data.length); i++) {
    console.log(`Fila ${i}:`, data[i]);
  }
} catch(err) {
  console.error("Error:", err.message);
}
