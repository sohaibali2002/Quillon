"use client";

// Account desk: session state, SSO sign-in/out, and the self-host checklist.
import { useCallback, useEffect, useState } from "react";
import { Pill } from "./ui-bits";

type SessionInfo = {
  ssoEnabled: boolean;
  signedIn: boolean;
  user: { name: string; email: string; roles: string[] } | null;
};

export default function AccountPanel() {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/session");
      if (!res.ok) throw new Error();
      setInfo((await res.json()) as SessionInfo);
      setError(null);
    } catch {
      setError("Could not reach the session API.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function signOut() {
    setWorking(true);
    try {
      await fetch("/api/auth/signout", { method: "POST" });
      await load();
    } finally {
      setWorking(false);
    }
  }

  if (!info && !error) return <p className="gp-fineprint">Loading session…</p>;

  return (
    <div className="gp-stack">
      {error && (
        <p className="gp-error" role="alert">
          {error}
        </p>
      )}
      <section className="gp-card">
        <h3 className="gp-sub">Session</h3>
        {info?.ssoEnabled ? (
          info.signedIn ? (
            <div className="gp-stack">
              <p className="gp-fineprint">
                Signed in via your identity provider as <b>{info.user?.name}</b>
                {info.user?.email ? ` (${info.user.email})` : ""}.
                {info.user?.roles.length ? ` Roles: ${info.user.roles.join(", ")}.` : ""}
              </p>
              <div>
                <button type="button" className="gp-btn" onClick={signOut} disabled={working}>
                  Sign out
                </button>
              </div>
            </div>
          ) : (
            <div className="gp-stack">
              <p className="gp-fineprint">You are not signed in.</p>
              <div>
                <a className="gp-btn" href="/api/auth/signin?redirect=/workspace">
                  Sign in with SSO
                </a>
              </div>
            </div>
          )
        ) : (
          <div className="gp-stack">
            <Pill tone="warn">Open mode — SSO not configured</Pill>
            <p className="gp-fineprint">
              Anyone with the URL can use this deployment. To require Microsoft Entra ID (or any
              OIDC provider), set these environment variables and restart:
            </p>
            <pre className="gp-code">{`AUTH_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0
AUTH_CLIENT_ID=<application id>
AUTH_CLIENT_SECRET=<secret>
AUTH_SCOPES=openid profile email
AUTH_SECRET=<random string for cookie signing>`}</pre>
            <p className="gp-fineprint">
              In Entra admin center: App registrations → New registration → Web platform, redirect
              URI <code>&lt;your origin&gt;/api/auth/callback</code>.
            </p>
          </div>
        )}
      </section>
      <section className="gp-card">
        <h3 className="gp-sub">Self-hosting</h3>
        <p className="gp-fineprint">
          Quillon is Apache-2.0 licensed. All data stays in your deployment: chat history, memory
          and connector credentials live in <code>.data/quillon.db</code>, and provider keys stay in
          your environment. No telemetry is sent anywhere.
        </p>
      </section>
    </div>
  );
}
