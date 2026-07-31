-- Los cobros digitados manualmente son hechos financieros de primera clase.
-- PostgreSQL exige confirmar la ampliación del enum antes de usar el valor en
-- funciones o datos; por eso esta migración está separada de la estructura.
alter type public.payment_execution_source add value if not exists 'manual_receipt';
