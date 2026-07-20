# Riesgos de aceptación: rediseño P2P

Este control está pensado para ejecutarse antes de integrar o desplegar cambios de Compras y Cuentas por Pagar:

```bash
node scripts/verify-p2p-redesign.mjs
```

## Qué cubre

- Seis vistas explícitas (resumen, solicitudes, órdenes, CxP, propuestas y financiamiento), cada una con navegación y render condicional. Esto evita volver a una pantalla de scroll interminable.
- Preservación de las seis entradas operativas: solicitud, OC, recepción conforme, cuenta por pagar, financiamiento y propuesta de pago.
- Transición de propuesta a ejecución y luego a conciliación mediante `payment_executions`; el pago no puede saltarse el banco.
- Clasificación funcional: gasto operativo/CxP, activo financiado de inversión con amortización, y crédito/deuda como financiamiento.
- Prohibición de textos visibles con “lote”. El identificador técnico `payment_batch` permanece en la API y base de datos por compatibilidad, pero la interfaz debe decir propuesta, orden o ejecución de pago.

## Límite conocido

No hay Playwright, Vitest ni una sesión de pruebas autenticada configurada en este repositorio. Por eso el script es un contrato estático de UI/API/migraciones, no una sustitución de un flujo browser contra Supabase. Antes de liberar producción conviene ejecutar una prueba manual autenticada con: solicitud aprobada → OC → recepción parcial → factura vinculada → propuesta aprobada → ejecución → cartola → conciliación.
