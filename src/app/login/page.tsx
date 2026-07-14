"use client";

import { FormEvent, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const { error } = await createClient().auth.signInWithPassword({ email, password });
    if (error) return setMessage(error.message);
    window.location.assign("/");
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <span className="brand-mark">A</span>
        <span className="eyebrow">ATLAS FINANCIERO</span>
        <h1>Ingresar</h1>
        <p>Accede con tu usuario autorizado.</p>
        <form onSubmit={signIn}>
          <label>Correo<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
          <label>Contraseña<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          {message && <p className="form-error">{message}</p>}
          <button className="primary-button" type="submit">Ingresar</button>
        </form>
      </section>
    </main>
  );
}
