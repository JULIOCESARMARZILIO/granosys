# Contexto operativo de GranoSYS

> Documento de continuidad para nuevas sesiones de Codex, Claude u otros agentes.
> Última actualización: 24 de agosto de 2026 (America/Argentina/Buenos_Aires).

## Instrucción de arranque para una nueva sesión

Antes de proponer o realizar cambios:

1. Leer este documento completo.
2. Inspeccionar el estado actual del repositorio y los PR recientes; no asumir que este archivo reemplaza al código.
3. Confirmar cuál es el entorno objetivo: producción original o copias aisladas de desarrollo.
4. No modificar producción, datos, variables, secretos, integraciones fiscales ni infraestructura salvo autorización expresa de Julio.
5. No inventar resultados de ARCA, CTG, CPE, certificados, liquidaciones ni datos de producción.
6. Ante una inconsistencia, diagnosticar con evidencia, preservar los datos y continuar con las partes seguras de la tarea.

## Fuentes autoritativas

- Repositorio original: `JULIOCESARMARZILIO/granosys`.
- Rama productiva: `main`.
- Aplicación productiva: `https://granosys-production.up.railway.app/`.
- Proyecto Railway original: `miraculous-learning`.
- Entorno Railway original: `production`.
- Servicio de aplicación: `granosys`.
- Base productiva: PostgreSQL administrado en Railway. Nunca copiar, borrar o alterar datos sin autorización específica.
- No registrar en este archivo contraseñas, certificados fiscales, claves privadas, tokens, cookies ni valores de variables de entorno.

## Estado productivo confirmado al 24/08/2026

- PR #78 fusionado: habilita el acceso al circuito Informal para todos los usuarios activos autenticados.
- Commit desplegado: `e0e5ddc3c7c51b452e54021458b4581cb667369f`.
- Deployment activo verificado en Railway: `29a9c3fc-756a-4e17-ac39-ca03221d222b`, estado `SUCCESS`.
- Los usuarios OPERADOR pueden acceder a Informal y crear movimientos sin recibir rol ADMIN.
- La gestión de usuarios, configuración y procesos sensibles continúa restringida a ADMIN.
- Decisión temporal: todos los usuarios activos quedan habilitados; más adelante se definirán permisos individuales.
- Railway observa cambios de `public/**`, `src/**`, `package.json` y `package-lock.json`.

## Arquitectura actual y separación planificada

Hoy el sistema original conserva Formal e Informal en la misma aplicación y base, diferenciados principalmente por `modalidad`.

Se crearon tres repositorios de trabajo separados, sin reemplazar todavía al original:

- `JULIOCESARMARZILIO/granosys-formal`
- `JULIOCESARMARZILIO/granosys-informal`
- `JULIOCESARMARZILIO/granosys-nucleo`

En las copias de Codex existe la rama `codex/separacion`. También existen entornos Railway aislados para comparar implementaciones de Codex y Claude. El GranoSYS original debe seguir funcionando hasta que la separación esté probada y aprobada.

Diseño acordado:

- Formal e Informal deben convivir con código y bases operativas separadas.
- Núcleo debe concentrar los datos maestros y servicios realmente compartidos.
- Los datos maestros se crean desde Formal/integración y se publican al resto para evitar duplicados.
- CUIT real único para una misma persona o empresa. Un CUIT inventado solo puede existir para una contraparte exclusivamente informal y debe reemplazarse/unificarse cuando ingrese al circuito formal.
- Se comparten contrapartes, clientes, productores, compradores, transportistas, especies, campañas y demás maestros definidos.
- Tesorería, cuentas corrientes, stock e informes pueden presentar vistas consolidadas, conservando el origen de cada movimiento.
- Las vinculaciones Informal -> Formal se administran desde Informal.
- Desde Formal no debe exponerse que un registro proviene o está vinculado al circuito Informal.
- La mercadería comprada en Informal puede aplicarse a un contrato, fijarse/venderse y transferirse a Formal como producción propia mediante una cuenta puente trazable.

## Reglas operativas de granos

### CPE y CTG

- No duplicar una CPE o CTG dentro de la misma modalidad.
- Un CTG puede aparecer una vez en Formal y otra en Informal cuando representa el mismo camión visto desde ambos circuitos; ambos movimientos deben quedar vinculados explícitamente.
- CTG con prefijo 101: salida de productor.
- CTG con prefijo 102: salida de planta; identificar y reportar aparte cuando corresponda a Inversiones del Salado.
- CPEDG debe conservarse como tipo documental distinto y no mezclarse en informes solicitados exclusivamente para CPE formal.
- Intervinientes: guardar CUIT y nombre para emisor, comprador, titular, remitente comercial, corredor, entregador, destinatario, destino, transportista y pagador del flete cuando existan.
- El comprador no es necesariamente el emisor. Se determina por el rol comercial real, no por posición visual o una etiqueta genérica.

### Certificados de depósito

- Los certificados deben almacenar su COE, datos generales, calidades y el detalle camión por camión.
- Cada detalle debe incluir el CTG/CPE relacionado, kilos, humedad, mermas y demás calidades disponibles.
- La descarga y los kilos netos certificados deben provenir prioritariamente del certificado cuando este aporta el detalle real, no reemplazarse por kilos brutos de ARCA.
- Si un movimiento ya está vinculado a un certificado, no desvincularlo para corregir kilos: actualizar la información derivada con trazabilidad.
- El saldo es por certificado.
- El detalle del certificado debe ser visible e interactivo en la interfaz, similar al documento original pero representado con datos del sistema.

### Liquidaciones

- Una liquidación puede consumir uno o varios certificados.
- Un certificado puede usarse completo o parcialmente.
- Las aplicaciones descuentan kilos netos del saldo de cada certificado.
- Solo vincular automáticamente coincidencias exactas; las ambiguas quedan pendientes de revisión.
- Conservar el detalle oficial completo de liquidaciones B/C y sus ajustes.
- No ejecutar acciones fiscales desde tareas de consulta, importación o conciliación.

### Stock y trazabilidad

- Debe poder reconstruirse el camino camión -> pesada/descarga -> calidad/merma -> contrato -> certificado -> liquidación -> cuenta corriente.
- Todo ajuste de stock debe registrar motivo, usuario, fecha, valor anterior y valor nuevo.
- No pisar historia para hacer cuadrar saldos.

## Tesorería, cuenta corriente y cuenta puente

- Tesorería se comparte funcionalmente, manteniendo separación y trazabilidad por circuito.
- La cuenta corriente no debe recibir pagos manuales directos por la pantalla antigua: los pagos deben nacer en Tesorería y generar su movimiento de cuenta corriente.
- Soportar efectivo, transferencias, cheques propios, cheques de terceros y eCheq.
- Permitir aplicaciones parciales, múltiples liquidaciones y sobrantes sin sobreaplicar saldos.
- La cuenta puente propuesta es `Inversiones Siembra`, aunque comparte CUIT con el circuito formal; debe identificarse mediante identidad interna/rol contable, no duplicando el CUIT.
- Todo pago del Formal destinado al Informal se caratula como `pago propio`.
- El instrumento físico pasa al circuito Informal, mientras Formal conserva un saldo virtual pendiente de imputación a proveedores formales.
- La subcartera de imputación debe conservar cada instrumento individual: número de cheque/eCheq, banco, emisor, fecha, vencimiento, importe, estado y aplicaciones. No debe reducirse a un único monto global.
- La subcartera muestra total, imputado y disponible para imputar, pero no duplica el saldo de caja/bancos ni genera por sí sola deuda con la cuenta puente.
- Cuando Informal entrega el cheque a un proveedor, Formal todavía debe poder imputar el uso fiscal/contable correspondiente sin alterar lo ocurrido físicamente en Informal.

## Auditoría y riesgos técnicos ya detectados

- Una pesada liquidada podía editarse sin bloqueo suficiente de estado/rol.
- Cuenta corriente y tesorería no auditaban todas las operaciones en la tabla inmutable.
- Faltaba una pantalla formal de ajuste de stock auditable.
- La tabla de mermas por humedad provenía de una carga inicial desde un Excel local y necesitaba versión, vigencia y fuente.
- El campo `saldo_acumulado` de movimientos de cuenta corriente no acumulaba realmente, aunque el saldo general sí se calculaba.
- La pantalla vieja de imputaciones no manejaba correctamente parciales, sobrantes y varias liquidaciones.
- Tesorería tenía backend avanzado pero faltaba interfaz completa, conciliación bancaria, flujo de fondos, vencimientos y operación móvil.
- La separación Formal/Informal/Núcleo debe resolverse con migraciones, identificadores estables e idempotencia; no copiando datos sin reglas de sincronización.

## Criterios de seguridad y despliegue

- Diagnósticos: solo lectura salvo autorización posterior.
- Cambios de código: rama, pruebas, PR, revisión y recién después fusión/despliegue.
- Verificar el SHA realmente desplegado; un `redeploy` de Railway puede reutilizar un snapshot viejo.
- No declarar una tarea desplegada hasta ver `SUCCESS`, commit correcto y arranque saludable.
- No imprimir ni copiar secretos de Railway/GitHub en chats, logs o documentos.
- No aceptar credenciales por chat; usar las interfaces seguras previstas.
- No crear, emitir, aceptar, rechazar, confirmar, modificar o anular operaciones fiscales salvo autorización expresa, específica y vigente.
- Mantener el sistema original operativo mientras se prueban las copias separadas.

## Pendientes prioritarios

1. Diseñar permisos por capacidad y usuario: acceso Formal, acceso Informal, creación/edición de movimientos, certificados, liquidaciones, tesorería, configuración y administración.
2. Completar extracción y visualización camión por camión de todos los certificados, con CTG, kilos netos, mermas y calidades.
3. Consolidar la vinculación certificados <-> liquidaciones con consumo parcial de saldo por certificado.
4. Corregir y completar auditoría inmutable en pesadas, stock, cuenta corriente, tesorería y derivados.
5. Construir la interfaz de Tesorería y reemplazar el ingreso directo de pagos en Cuenta Corriente.
6. Diseñar y probar la cuenta puente y la subcartera de pagos propios por instrumento.
7. Definir contratos de sincronización y migraciones para Formal, Informal y Núcleo.
8. Mejorar navegación móvil y de escritorio sin exponer relaciones informales desde Formal.
9. Probar backups y restauración antes de cualquier migración de arquitectura.

## Formato recomendado para entregar trabajo

Toda sesión debe informar:

- Qué encontró o cambió, con evidencia concreta.
- Repositorio, rama, PR y commit.
- Pruebas ejecutadas y resultado.
- Entorno y deployment, si corresponde.
- Datos modificados y forma de reversión.
- Riesgos o pendientes que no pudo cerrar.

Nunca afirmar que algo quedó cargado, vinculado, fusionado o desplegado sin evidencia verificable.
