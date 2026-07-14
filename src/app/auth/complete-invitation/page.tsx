"use client";

import { FormEvent, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type ActivationState = "checking" | "ready" | "invalid";

export default function CompleteInvitationPage() {
  const [activationState, setActivationState] = useState<ActivationState>("checking");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    const syncSession = async () => {
      const { data } = await supabase.auth.getSession();
      setEmail(data.session?.user.email ?? "");
      setActivationState(data.session ? "ready" : "invalid");
    };

    void syncSession();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user.email ?? "");
      setActivationState(session ? "ready" : "invalid");
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  async function completeActivation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    if (password.length < 12) return setMessage("Usa una contraseña de al menos 12 caracteres.");
    if (password !== confirmation) return setMessage("Las contraseñas no coinciden.");

    setIsSaving(true);
    const { error } = await createClient().auth.updateUser({ password });
    setIsSaving(false);
    if (error) return setMessage("No fue posible definir la contraseña. Solicita una nueva invitación al administrador.");
    window.location.assign("/");
  }

  return (
    <main className="login-page">
      <section className="login-card invitation-card">
        <span className="brand-mark">A</span>
        <span className="eyebrow">ATLAS FINANCIERO</span>
        {activationState === "checking" && <><h1>Validando acceso</h1><p>Estamos verificando tu invitación de forma segura.</p></>}
        {activationState === "invalid" && <>
          <h1>Enlace no disponible</h1>
          <p>Este enlace ya fue utilizado o venció. Solicita una nueva invitación al administrador de tu organización.</p>
          <a className="secondary-link" href="/login">Volver a ingresar</a>
        </>}
        {activationState === "ready" && <>
          <h1>Activa tu acceso</h1>
          <p>Define una contraseña para <strong>{email}</strong>. Al continuar podrás entrar a Atlas Financiero.</p>
          <form onSubmit={completeActivation}>
            <label>Contraseña<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={12} required /></label>
            <label>Confirmar contraseña<input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" minLength={12} required /></label>
            {message && <p className="form-error">{message}</p>}
            <button className="primary-button" type="submit" disabled={isSaving}>{isSaving ? "Activando…" : "Activar acceso"}</button>
          </form>
        </>}
      </section>
    </main>
  );
}
