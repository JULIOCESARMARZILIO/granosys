const XLSX = require('xlsx');
const excelPath = "C:/Users/JCMARZILIO/Desktop/tabla de mermas humedad.xlsx";

const wb = XLSX.readFile(excelPath);
const sheet = wb.Sheets["tabla de mermas"];
const data = XLSX.utils.sheet_to_json(sheet, {header: 1});
console.log("Columnas de la fila 0:", data[0]);
console.log("Columnas de la fila 1:", data[1]);
