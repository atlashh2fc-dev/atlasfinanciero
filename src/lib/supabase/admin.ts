import { createClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "./env";

function getSecretKey() {
  return process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? null;
}

export function hasSupabaseAdminKey() {
  return Boolean(getSecretKey());
}

export function createAdminClient() {
  const secretKey = getSecretKey();
  if (!secretKey) throw new Error("Falta una clave privada de Supabase para provisionar usuarios.");

  const { url } = getSupabaseEnv();
  return createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
