"use client";

import { FormEvent, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [isRecovering, setIsRecovering] = useState(false);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const { error } = await createClient().auth.signInWithPassword({ email, password });
    if (error) return setMessage(error.message);
    window.location.assign("/");
  }

  async function requestPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const { error } = await createClient().auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/complete-invitation`,
    });
    if (error) return setMessage("No fue posible solicitar el enlace. Inténtalo nuevamente.");
    setMessage("Si existe una cuenta para este correo, recibirás un enlace seguro para definir tu contraseña.");
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <span className="brand-mark">A</span>
        <span className="eyebrow">ATLAS FINANCIERO</span>
        <h1>{isRecovering ? "Recuperar acceso" : "Ingresar"}</h1>
        <p>{isRecovering ? "Te enviaremos un enlace seguro para definir una contraseña nueva." : "Accede con tu usuario autorizado."}</p>
        {isRecovering ? <form onSubmit={requestPasswordReset}>
          <label>Correo<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
          {message && <p className="form-error">{message}</p>}
          <button className="primary-button" type="submit">Enviar enlace seguro</button>
          <button className="login-link-button" type="button" onClick={() => { setIsRecovering(false); setMessage(""); }}>Volver a ingresar</button>
        </form> : <form onSubmit={signIn}>
          <label>Correo<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
          <label>Contraseña<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
          {message && <p className="form-error">{message}</p>}
          <button className="primary-button" type="submit">Ingresar</button>
          <button className="login-link-button" type="button" onClick={() => { setIsRecovering(true); setMessage(""); }}>¿Olvidaste tu contraseña?</button>
        </form>}
      </section>
    </main>
  );
}
