# Propuesta de mayores contables para GranoSYS

Estado: diseño; no genera asientos todavía.

## Principio

La contabilidad debe recibir eventos confirmados de los módulos operativos. Un contrato no genera asiento por sí solo. Una factura, liquidación, recepción/entrega valorizada, nota de crédito, cobro o pago sí puede generarlo. Cada asiento debe conservar el vínculo con el documento y la operación que lo originó.

## Ejes separados

- Origen físico: productor o planta.
- Origen comercial: producción propia, compra formal o compra informal.
- Modalidad de compra: formal o informal.
- Modalidad de venta: formal o informal.
- Producto real: grano o derivado específico.
- Documento fiscal: factura de compra, factura de venta, liquidación, CPEDG u otro.

## Mayores mínimos

### Activo

- Caja y bancos por cuenta y moneda.
- Créditos por ventas.
- IVA crédito fiscal.
- IVA saldo a favor.
- Stock de granos por producto y ubicación.
- Stock de derivados por producto y ubicación.
- Anticipos a proveedores.

### Pasivo

- Proveedores de granos.
- Proveedores de derivados.
- Transportistas a pagar.
- IVA débito fiscal.
- Retenciones y percepciones a depositar.
- Anticipos de clientes.

### Resultados

- Ventas de granos por especie.
- Ventas de derivados por producto real.
- Costo de mercadería vendida.
- Compras de granos.
- Compras de derivados.
- Fletes de compra.
- Fletes de venta.
- Secada, zarandeo, paritaria, fumigación y acondicionamiento.
- Comisiones.
- Diferencias de cambio.
- Mermas de cantidad y calidad.

## Eventos y asientos esperados

| Evento confirmado | Debe | Haber |
|---|---|---|
| Factura de compra | Stock/Compras + IVA crédito | Proveedores |
| Factura de venta | Créditos por ventas | Ventas + IVA débito |
| Costo de venta | Costo de mercadería vendida | Stock |
| Factura de flete de compra | Stock o Flete de compra + IVA crédito | Transportista/Proveedor |
| Factura de flete de venta | Flete de venta + IVA crédito | Transportista/Proveedor |
| Cobro | Banco/Caja | Créditos por ventas |
| Pago | Proveedores/Transportistas | Banco/Caja |
| Nota de crédito | Reversión proporcional del asiento original | Reversión proporcional |

## Trazabilidad obligatoria

Cada renglón contable debería guardar `asiento_id`, `cuenta_id`, debe/haber, moneda, cotización y referencias opcionales a contrato, operación de derivado, movimiento, factura/documento ARCA, liquidación, contraparte y pago/cobro.

## Controles antes de activar

- Idempotencia por documento fiscal y tipo de evento.
- Debe igual a haber en cada asiento.
- No contabilizar borradores ni duplicar el formal/informal espejo.
- Solo la representación contable elegida de un grupo impacta stock y mayores.
- Reversión mediante contraasiento; nunca borrar asientos contabilizados.
- Cierre mensual con bloqueo y reapertura auditada.
