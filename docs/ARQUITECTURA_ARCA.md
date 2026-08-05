# Arquitectura viva de integración ARCA

## Principios obligatorios

- La sincronización oficial es de solo lectura y puede ejecutarse automáticamente.
- Emitir, anular, ajustar, asociar o registrar documentos fiscales requiere aprobación humana explícita.
- La IA prepara propuestas, pero nunca las aprueba ni ejecuta por sí sola.
- Certificados, claves privadas, token y firma permanecen en el servidor.
- Toda importación conserva fuente, clave externa, fecha, carga oficial y hash SHA-256.

## Fuentes

- WSFE: facturas emitidas. Primera sincronización desde 2026-01-01.
- WSCDC: constatación de comprobantes conocidos; no ofrece listado masivo de recibidos.
- WSCPE: cartas de porte emitidas, recibidas e intervinientes.
- WSLPG: liquidaciones primarias y secundarias, ajustes y certificados electrónicos.
- Portal IVA / Libro IVA Digital: complemento para comprobantes recibidos.

## Equivalencias documentales

- Ex C1116A: Certificación Primaria de Depósito de Granos.
- Ex C1116B/C: Liquidación Primaria de Granos.
- También se contemplan certificados de retiro y transferencia, ajustes y LSG.

## Estado al 2026-08-03

- Certificado productivo `IDS-granoSYS` válido y coincidente con su clave privada.
- Autorizados: `wsfe`, `wscdc`, `wscpe`, `wslpg`, `ws_sr_padron_a13`.
- Implementado diagnóstico de autorizaciones WSAA.
- Primera sincronización WSFE completada: 181 comprobantes emitidos desde 2026-01-01, sin errores.
- Implementada sincronización por lotes de facturas emitidas con trabajo en segundo plano.
- Implementada pantalla de consulta de documentos ARCA con filtros, detalle, hash y conciliación por CUIT.
- Las contrapartes existentes se vinculan por CUIT normalizado. Las faltantes quedan como propuestas pendientes; no se crean silenciosamente.
- Implementada sincronización consultiva WSLPG por punto de emisión para LPG, LSG, ajustes incluidos y certificaciones electrónicas.
- Pendiente: identificar todos los puntos de emisión WSLPG utilizados, sincronizador WSCPE, importación Portal IVA y flujo de aprobación reforzado.

## Restricciones conocidas de consulta

- WSLPG recupera por punto de emisión y número de orden los documentos emitidos por la CUIT representada.
- Los documentos recibidos no disponen de un listado masivo equivalente en WSFE/WSCDC. Se integrarán mediante Portal IVA / Libro IVA Digital y luego se validarán contra los servicios oficiales.
