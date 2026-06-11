const XLSX = require('xlsx');
const excelPath = "C:/Users/JCMARZILIO/Desktop/tabla de mermas humedad.xlsx";

try {
  const wb = XLSX.readFile(excelPath);
  console.log("Hojas:", wb.SheetNames);
  const sheet = wb.Sheets["tabla de mermas"];
  if (!sheet) {
    console.error("No se encontró la hoja 'tabla de mermas'");
    process.exit(1);
  }
  const data = XLSX.utils.sheet_to_json(sheet);
  console.log("Data count:", data.length);
  console.log("Primeras 50 filas:", JSON.stringify(data.slice(0, 50), null, 2));
} catch(err) {
  console.error("Error:", err.message);
}
