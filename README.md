# Atlas Financiero · base trazable

Aplicación web en Next.js, TypeScript, Tailwind CSS y Recharts para sustituir la lectura manual de la hoja de facturas por una vista operacional y auditable.

## Estado actual

- Se importó el libro completo `Facturas Emitidas.xlsx` al proyecto Supabase `bydhikcehslzyxhwtrac` y el archivo original quedó en un bucket privado.
- La carga conserva 11.071 celdas fuente, incluidas fórmulas, 126 documentos emitidos históricos, 19 contrapartes y cuatro lotes por hoja de facturas.
- Proyecciones normaliza únicamente líneas de detalle: 192 de ingresos proyectados, 132 del bloque `Real 2026` y 177 de gastos proyectados. Totales y conciliaciones permanecen intactos en la fuente, pero no se duplican en los gráficos.
- Cada registro conserva la referencia `archivo → hoja → fila` y cada proyección también su columna de origen.
- Clientes incorpora una matriz evolutiva con los meses en columnas, monto neto documentado, documentos y estado `Pendiente` exacto por cliente.
- La base financiera incorpora periodos, plan de cuentas, asientos doble partida, líneas de planificación, calendario de reconocimiento de ingresos y vistas de evolución mensual. No se precargaron cuentas, asientos ni políticas contables que no estén en la fuente.
- El formulario crea registros sólo en la sesión del navegador. No afirma persistencia ni modifica el libro Excel.
- La capa de remuneraciones incorpora una integración preparada para PeopleWork: configuración sin secretos en base de datos, ejecuciones auditables y costos agregados por período, categoría y centro de costo. No persiste liquidaciones ni información personal de colaboradores.
- **Provisiones de remuneraciones** parte desde un snapshot anual activo y transaccional de PeopleWork, permite incorporar supuestos manuales y conserva versiones semanales. Cada versión contabilizada registra sólo la diferencia contra la anterior; un borrador obsoleto se bloquea y los borradores nunca impactan Reportes.
- El costo laboral reconocido usa una precedencia excluyente por mes: nómina real cuando existe; en caso contrario, última provisión contabilizada. La nómina real puede cargarse manualmente por centro de costo y reemplaza, sin sumarse, a la provisión en EERR y rentabilidad por centro. El cierre exige provisión contabilizada y, cuando existe el real, conciliación completa.
- Cuentas por cobrar incorpora ciclos de facturación recurrente: sólo Finanzas o Administrador pueden confirmar una recurrencia; cada ciclo debe quedar listo a más tardar el día 2, abre alerta preventiva y escala a vencida si permanece pendiente. Un trabajo diario en Supabase mantiene las alertas activas.
- Tesorería incorpora una cartera separada de préstamos otorgados a empresas. El contrato no se trata como factura ni cuenta por pagar: el desembolso y cada devolución se concilian contra la cartola y generan asientos automáticos que separan capital e intereses.
- Cada cuenta bancaria puede distribuirse entre uno o más centros de costo con porcentajes que suman 100%. Los movimientos importados heredan esa distribución como una copia histórica para leer ingresos y egresos por centro, con ajuste manual por movimiento.
- Hay modelos, RLS, bitácora e importaciones para documentos, terceros, forecast y archivos fuente. El primer usuario administrador aún debe ser definido explícitamente antes de habilitar escritura real desde la interfaz.

## Ejecutar

```bash
pnpm install
pnpm dev
```

Para una validación de producción:

```bash
pnpm typecheck
pnpm build
```

## Conexión con Supabase

La aplicación usa la URL y Publishable Key pública en `.env.local` (archivo ignorado por Git). Nunca pongas `service_role` en variables `NEXT_PUBLIC_`.

Las credenciales de PeopleWork se mantienen exclusivamente en variables de servidor (`PEOPLEWORK_*`), sin prefijo `NEXT_PUBLIC_`. Para activar la sincronización se necesita, además de la API Key y Secret Key, el contrato técnico de PeopleWork: URL base, esquema de autenticación y endpoint/campos del costo de remuneraciones. El modelo no asume esos elementos ni intenta convertir liquidaciones individuales.

### SII · DTE recibidos

La integración directa usa los Web Services oficiales del SII para autenticación con certificado digital, consulta de historial/fecha de recepción y Registro de Aceptación o Reclamo. No guarda certificados, contraseñas ni tokens en Supabase: `SII_PRIVATE_KEY_PEM` y `SII_CERTIFICATE_PEM` son secretos de servidor en PEM. El certificado debe pertenecer a un representante legal o usuario autorizado para el RUT configurado.

Cada documento debe tener RUT de emisor, tipo SII y folio. El WS de registro cubre los tipos 33, 34 y 43 y las acciones `ACD` (aceptar contenido), `ERM` (acuse de mercaderías/servicios), `RCD` (reclamo de contenido), `RFP` y `RFT` (falta parcial/total). Las acciones se registran primero en la bitácora y requieren confirmación explícita; no hay aceptación automática. La fecha de recepción del SII se consulta para calcular la alerta interna de ocho días.

El SII no entrega un webhook de facturas recibidas en estos WS. La entrada debe ser el correo tributario del receptor, un proveedor que entregue el XML, o una carga controlada; en todos los casos se deduplica por RUT emisor + tipo + folio antes de registrar un DTE.

La sección **Bandeja mail** permite a Finanzas y Auditoría ver la trazabilidad de cada correo procesado: asunto, remitente, fecha, cantidad de adjuntos, resultado y documento asociado. No almacena ni muestra el cuerpo de los correos. Un Administrador puede ejecutar una revisión manual; ésta importa DTE y busca comprobantes de pago, dejando los casos ambiguos pendientes de conciliación. Para habilitar el lector se configuran, exclusivamente como secretos de servidor, `SII_IMAP_HOST`, `SII_IMAP_PORT`, `SII_IMAP_USER` y `SII_IMAP_PASSWORD`.

### SII · Registro de Compras y Ventas (fuente maestra)

El descubrimiento de documentos ya no depende del correo: un trabajo diario descarga el Registro de Compras y Ventas oficial del SII (compras y ventas del período actual y anterior) autenticándose con el mismo certificado digital. El RCV usa los endpoints JSON de la interfaz web del SII (`consdcvinternetui`), que no son una API publicada: el parseo es tolerante y cada fila se conserva cruda en `sii_rcv_entries` con su corrida de origen (`sii_rcv_sync_runs`), cumpliendo la regla de staging trazable.

El merge vincula cada entrada del RCV con los documentos operacionales por RUT + tipo + folio: si el documento no existe se crea desde el registro oficial (estado `Pendiente de revisión`); si existe con montos distintos se marca `amount_mismatch` sin sobrescribir nada; la fecha de recepción del SII alimenta la alerta de ocho días. El correo tributario queda como enriquecedor: aporta el XML con líneas de detalle y respaldos, casando contra el mismo identificador. El RCV sólo existe en el ambiente de producción del SII; en certificación la sincronización se rechaza explícitamente.

Las migraciones incluyen organizaciones, perfiles, membresías por rol, terceros, documentos emitidos, lotes de importación, forecast, almacenamiento privado del libro y auditoría. Las políticas RLS impiden lectura y edición fuera de la organización.

Para incorporar el primer usuario, crea o confirma su cuenta en Supabase Auth y asígnala a GEIMSER con el rol `administrator`. No se asigna este permiso automáticamente a una dirección de correo supuesta.

## Arquitectura objetivo

```text
Usuarios + RBAC
       │
       ▼
Next.js (operación, aprobaciones, dashboard)
       │
       ├── API / validaciones / bitácora
       ▼
PostgreSQL
  ├── organizaciones, usuarios, roles, permisos
  ├── terceros (clientes, proveedores, contactos, RUT)
  ├── documentos, líneas, impuestos, adjuntos
  ├── cobros, pagos, vencimientos, factoring
  ├── centros de costo y presupuestos
  └── importaciones, errores, versiones y auditoría
       │
       ├── remuneraciones (futura integración)
       └── BI / reportes / exportaciones
```

### Módulos

1. **Documentos emitidos**: facturas, notas de crédito, documentos exentos, estado, vencimiento y pago.
2. **Clientes**: evolución mensual, concentración, documentos, estado y trazabilidad por cliente.
3. **Cuentas por cobrar**: calendario de vencimientos, pagos, abonos, factoring, cartera y control de recurrentes. Una regla explícita abre los ciclos mensuales y alerta antes del día 2; no se clasifican facturas históricas como recurrentes por inferencia.
4. **Gastos y proveedores**: documentos recibidos, órdenes de compra, centros de costo y aprobaciones.
5. **Remuneraciones**: importación de costos de personal a centros de costo y períodos, sin exponer liquidaciones a roles no autorizados.
6. **Proyecciones**: evolución mensual con presupuesto, bloque `Real 2026`, gastos, resultado simple y desviaciones, sin modificar valores fuente.
7. **Préstamos otorgados**: contratos de mutuo, capital pendiente, vencimiento, partes relacionadas, control de Timbres y Estampillas, devoluciones y conciliación bancaria con asiento automático.

### Roles iniciales

| Rol | Alcance |
| --- | --- |
| Administrador | Configura organización, usuarios, catálogos e importaciones. |
| Finanzas | Registra, valida y aprueba documentos, cobros y pagos. |
| Operación | Prepara documentos y adjuntos para revisión, sin cierre contable. |
| Auditor | Consulta datos, bitácora e importaciones sin editar. |
| Digitador | Registra facturas de venta y costos pendientes de revisión, sin acceso a resultados, balances, pagos ni remuneraciones. |

La autorización se aplica mediante autenticación y políticas en servidor/base de datos; no depende sólo de ocultar módulos en la interfaz.

## Regla de datos

La fuente manda. Todo dato importado debe entrar a una zona de staging, validarse y conservar el identificador de la carga y de la fila de origen. Las transformaciones deben ser visibles, reversibles y auditables; no se deben completar campos financieros mediante suposiciones.

Antes de pasar a producción se deben acordar explícitamente: signo y efecto de notas de crédito, significado de cada estado, tratamiento de abonos y factoring, documento duplicado por emisor, validación de RUT, fecha de corte y reglas de cierre.

## Reimportar el libro

El importador operativo está preparado como migración reproducible en `supabase/migrations/20260714170811_import_full_facturacion_workbook.sql`; el libro completo se lee por XML estándar del `.xlsx`, porque contiene metadatos de comentarios que algunos lectores de Excel no aceptan. Para una próxima versión del proceso de carga, se debe generar un lote nuevo: nunca sobrescribir la carga histórica ni sus referencias de origen.

```bash
python3 scripts/import-facturas-2026.py "/ruta/Facturas Emitidas.xlsx"
```
