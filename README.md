# Atlas Financiero · MVP trazable

Aplicación web en Next.js, TypeScript, Tailwind CSS y Recharts para sustituir la lectura manual de la hoja de facturas por una vista operacional y auditable.

## Estado del MVP

- Importa como fuente inicial los 57 registros de `Facturas emitidas 2026` del archivo entregado `Facturas Emitidas.xlsx`.
- Cada registro conserva la referencia `archivo → hoja → fila`.
- Los KPI son sumas directas de las columnas `Monto Neto` y `Monto total Facturado`; no reclasifican ni compensan notas de crédito.
- El formulario crea registros sólo en la sesión del navegador. No afirma persistencia ni modifica el libro Excel.
- No se incorporan datos de proveedores, gastos o remuneraciones, porque no estaban en la fuente analizada.

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

La integración está preparada, pero no queda conectada hasta cargar las credenciales del proyecto. Copia `.env.example` a `.env.local` y completa únicamente la URL y Publishable Key pública. Nunca pongas `service_role` en variables `NEXT_PUBLIC_`.

La primera migración está en `supabase/migrations/` e incluye organizaciones, usuarios, membresías con roles, terceros, documentos emitidos, lotes de importación y auditoría. Antes de aplicarla al proyecto remoto se debe enlazar el proyecto y verificar las políticas RLS con usuarios de cada rol.

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
2. **Terceros**: maestro único de clientes y proveedores, usando RUT como identificador de negocio validado.
3. **Cuentas por cobrar**: calendario de vencimientos, pagos, abonos, factoring y cartera; sus reglas deben configurarse antes de calcular saldos.
4. **Gastos y proveedores**: documentos recibidos, órdenes de compra, centros de costo y aprobaciones.
5. **Remuneraciones**: importación de costos de personal a centros de costo y períodos, sin exponer liquidaciones a roles no autorizados.
6. **Presupuesto y gestión**: versión de presupuesto, real, forecast, variaciones y cierre de período.

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

El importador está en `scripts/import-facturas-2026.py`. Usa sólo XML estándar del `.xlsx`, porque el libro fuente incluye metadatos de comentarios que el lector de Excel usado para inspección no acepta. Ejecutar:

```bash
python3 scripts/import-facturas-2026.py "/ruta/Facturas Emitidas.xlsx"
```
