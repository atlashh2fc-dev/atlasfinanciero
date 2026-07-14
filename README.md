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
3. **Cuentas por cobrar**: calendario de vencimientos, pagos, abonos, factoring y cartera; sus reglas deben configurarse antes de calcular saldos.
4. **Gastos y proveedores**: documentos recibidos, órdenes de compra, centros de costo y aprobaciones.
5. **Remuneraciones**: importación de costos de personal a centros de costo y períodos, sin exponer liquidaciones a roles no autorizados.
6. **Proyecciones**: evolución mensual con presupuesto, bloque `Real 2026`, gastos, resultado simple y desviaciones, sin modificar valores fuente.

### Roles iniciales

| Rol | Alcance |
| --- | --- |
| Administrador | Configura organización, usuarios, catálogos e importaciones. |
| Finanzas | Registra, valida y aprueba documentos, cobros y pagos. |
| Operación | Prepara documentos y adjuntos para revisión, sin cierre contable. |
| Auditor | Consulta datos, bitácora e importaciones sin editar. |

La interfaz actual sólo simula la vista de rol. La autorización efectiva requiere autenticación y políticas en servidor/base de datos.

## Regla de datos

La fuente manda. Todo dato importado debe entrar a una zona de staging, validarse y conservar el identificador de la carga y de la fila de origen. Las transformaciones deben ser visibles, reversibles y auditables; no se deben completar campos financieros mediante suposiciones.

Antes de pasar a producción se deben acordar explícitamente: signo y efecto de notas de crédito, significado de cada estado, tratamiento de abonos y factoring, documento duplicado por emisor, validación de RUT, fecha de corte y reglas de cierre.

## Reimportar el libro

El importador operativo está preparado como migración reproducible en `supabase/migrations/20260714170811_import_full_facturacion_workbook.sql`; el libro completo se lee por XML estándar del `.xlsx`, porque contiene metadatos de comentarios que algunos lectores de Excel no aceptan. Para una próxima versión del proceso de carga, se debe generar un lote nuevo: nunca sobrescribir la carga histórica ni sus referencias de origen.

```bash
python3 scripts/import-facturas-2026.py "/ruta/Facturas Emitidas.xlsx"
```
