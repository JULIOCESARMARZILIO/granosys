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
- WSCPE: detalle y PDF por CTG; enumeracion historica por destino/planta y consolidacion de otros roles desde listados oficiales.
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
- En WSFE las contrapartes existentes se vinculan por CUIT normalizado y las faltantes quedan pendientes de decision humana.
- En CPE, por autorizacion funcional expresa, cada interviniente oficial se vincula por CUIT y puede crear el maestro FORMAL si ARCA devuelve razon social; la importacion nunca crea movimientos de cuenta corriente.
- Implementada sincronización consultiva WSLPG por punto de emisión para LPG, LSG, ajustes incluidos y certificaciones electrónicas.
- Implementado sincronizador WSCPE de solo consulta con identidad global por CTG, detalle completo, intervinientes, plantas, PDF y auditoria append-only.
- Implementada enumeracion WSCPE por destino/planta desde 2026-02-01 y carga masiva de la columna CTG de archivos oficiales para remitente comercial u otros roles no enumerables por el Web Service.
- Pendiente: identificar todos los puntos de emisión WSLPG utilizados, importación Portal IVA y flujo de aprobación reforzado.

## Control fiscal de IVA Ventas

- El XML oficial de WSFE es la evidencia primaria y se conserva sin alteraciones junto con su hash SHA-256.
- El resumen consultivo normaliza total, neto gravado, IVA, operaciones exentas, conceptos no gravados y otros tributos.
- El IVA se desglosa por codigo de alicuota y los tributos por codigo y descripcion.
- Las notas de credito se exponen con signo negativo para obtener el movimiento fiscal neto del periodo.
- Se controla que total = no gravado + neto gravado + exento + tributos + IVA, con tolerancia de dos centavos.
- El resultado no presenta IVA Simple, no reemplaza el Libro IVA Digital, no genera asientos y exige revision humana.
- IVA Compras, retenciones y percepciones sufridas quedan fuera de este primer alcance hasta incorporar su fuente oficial.

## Conciliacion con cuenta corriente

- `arca_cc_reconciliations` registra la decision humana sin modificar el documento oficial.
- La deteccion busca contraparte por CUIT y posibles movimientos por importe, modalidad y cercania de fecha.
- Vincular un movimiento existente evita duplicar deudas originadas previamente por liquidaciones.
- Crear un movimiento requiere ADMIN, confirmacion explicita, transaccion e idempotencia por documento ARCA.
- Facturas y notas de debito crean debe; notas de credito crean haber.
- Solo se permiten movimientos FORMAL en pesos en esta etapa. Moneda extranjera exige revision manual.
- Rechazar conserva evidencia, usuario, fecha, importe y hash; no borra ni altera el comprobante.

## Restricciones conocidas de consulta

- WSLPG recupera por punto de emisión y número de orden los documentos emitidos por la CUIT representada.
- Los documentos recibidos no disponen de un listado masivo equivalente en WSFE/WSCDC. Se integrarán mediante Portal IVA / Libro IVA Digital y luego se validarán contra los servicios oficiales.
- WSCPE no publica una consulta historica general por CUIT/rol. `consultarCPEPorDestino` solo enumera la calidad destino para planta y rango de fechas; remitente comercial y otros roles requieren obtener los CTG del listado oficial interactivo y luego consultar cada documento por WSCPE.


## Trazabilidad CPE → certificado → liquidación (v2.7.8)

- Los vínculos por CTG exacto se confirman automáticamente porque constituyen una referencia oficial determinística.
- Cuando el certificado no informa CTG, el sistema genera propuestas usando CUIT de intervinientes, especie, campaña, cercanía de fechas y una combinación de CPE cuya suma de kilos concilie el peso certificado.
- La tolerancia por defecto para kilos es el mayor valor entre 50 kg y 1% del certificado; la diferencia siempre queda visible.
- Las propuestas heurísticas nunca producen efectos fiscales ni quedan confirmadas sin intervención humana.
- La vinculación certificado–liquidación usa la referencia oficial exacta al COE o número de certificado dentro del documento WSLPG.
- La tabla `arca_trace_links` conserva método, puntaje, kilos comparados, diferencia, evidencia, estado y usuario revisor para auditoría.
