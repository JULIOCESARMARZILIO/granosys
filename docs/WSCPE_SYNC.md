# Sincronizacion WSCPE por CTG

- La consulta usa exclusivamente los metodos de detalle publicados en el WSDL WSCPE: Automotor, Ferroviaria, Automotor DG, Ferroviaria DG, Emision en Destino DG y Ductos DG.
- `arca_cpe_registry.ctg` es la identidad global: un CTG no puede representar dos documentos internos.
- El XML oficial completo, excepto el bloque binario duplicado del PDF, queda versionado por hash en `arca_official_documents`.
- El PDF se valida por firma `%PDF-`, se almacena en `arca_official_files` y se deduplica por documento, tipo y SHA-256.
- `arca_cpe_participants` conserva cada CUIT y rol oficial; se vincula con la contraparte existente o se intenta completar mediante Padron A13 antes del alta formal.
- `arca_cpe_plants` conserva origen, destino, numero, CUIT titular y domicilio; se vincula sin duplicar con `ubicaciones`.
- Cada importacion exitosa deja un evento append-only en `arca_cpe_import_events`, con usuario, trabajo, hash del detalle y hash del PDF.
- `POST /api/arca/sync/cpe-por-ctg` inicia un trabajo de solo consulta. `GET /api/arca/documentos/:id/pdf` entrega el original almacenado.
- WSCPE no ofrece una consulta historica unica para todos los roles. La enumeracion exhaustiva de CTG se obtiene de los listados oficiales y el detalle/PDF se consolida por Web Service.

## Limites de seguridad

Este flujo no invoca operaciones de emision, autorizacion, aceptacion, rechazo, desactivacion, anulacion ni cambio de destino. Cualquier futura incorporacion de una operacion mutante requiere un flujo separado con autorizacion humana explicita.

