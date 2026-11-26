"use client";

// Connectors desk: the enterprise data sources Quillon may use, with
// credentials stored encrypted at rest.
import { useCallback, useEffect, useState } from "react";
import { Pill } from "./ui-bits";

type Connector = {
  id: string;
  name: string;
  category: "files" | "tickets" | "chat" | "crm" | "knowledge";
  description: string;
  auth: "oauth2" | "pat";
  scopes: string[];
  docs: string;
  connected: boolean;
  tokenHint: string | null;
  tools: { id: string; description: string }[];
};

export default function ConnectorsPanel() {
  const [items, setItems] = useState<Connector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tokenFor, setTokenFor] = useState<Connector | null>(null);
  const [token, setToken] = useState("");
  const [account, setAccount] = useState("");
  const [saving, setSaving] = useState(false);
  const [openTools, setOpenTools] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/connectors");
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { connectors: Connector[] };
      setItems(data.connectors);
      setError(null);
    } catch {
      setError("Could not reach the connectors API.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!tokenFor || !token.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/connectors/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectorId: tokenFor.id, token: token.trim(), account: account.trim() }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        throw new Error(d.error ?? "Save failed");
      }
      setTokenFor(null);
      setToken("");
      setAccount("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function disconnect(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/connectors?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      await load();
    } catch {
      setError("Disconnect failed.");
    } finally {
      setBusyId(null);
    }
  }

  if (!items && !error) return <p className="gp-fineprint">Loading connectors…</p>;

  return (
    <div className="gp-stack">
      {error && (
        <p className="gp-error" role="alert">
          {error}
        </p>
      )}
      <p className="gp-fineprint">
        Credentials are encrypted with AES-256-GCM before they touch disk. OAuth connectors accept
        an access token from the provider&apos;s own consent screen; token connectors take an API
        token.
      </p>
      <ul className="cn-list">
        {(items ?? []).map((c) => (
          <li key={c.id} className="cn-item">
            <div className="cn-row">
              <div className="cn-main">
                <b>{c.name}</b>
                <span>{c.description}</span>
                <small>
                  {c.category} · {c.auth === "oauth2" ? "OAuth 2.0" : "API token"}
                  {c.scopes.length > 0 ? ` · ${c.scopes.join(", ")}` : ""}
                </small>
              </div>
              <div className="cn-side">
                {c.connected ? (
                  <Pill tone="ok">Connected {c.tokenHint ? c.tokenHint : ""}</Pill>
                ) : (
                  <Pill tone="idle">Not connected</Pill>
                )}
                <a href={c.docs} target="_blank" rel="noreferrer" className="gp-link">
                  Docs
                </a>
                {c.tools.length > 0 && (
                  <div className="cn-tools">
                    <button
                      type="button"
                      className="cn-tools-toggle"
                      aria-expanded={openTools.has(c.id)}
                      onClick={() =>
                        setOpenTools((prev) => {
                          const next = new Set(prev);
                          if (next.has(c.id)) next.delete(c.id);
                          else next.add(c.id);
                          return next;
                        })
                      }
                    >
                      {c.tools.length} native tool{c.tools.length === 1 ? "" : "s"}
                    </button>
                    {/* Rendered only while open: 200+ action rows stay out of the DOM otherwise. */}
                    {openTools.has(c.id) && (
                      <ul>
                        {c.tools.map((t) => (
                          <li key={t.id}>
                            <code>{t.id}</code>
                            <span>{t.description}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {c.connected ? (
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm"
                    onClick={() => disconnect(c.id)}
                    disabled={busyId === c.id}
                  >
                    {busyId === c.id ? "Removing…" : "Remove"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setTokenFor(c)}
                  >
                    Connect
                  </button>
                )}
              </div>
            </div>
            {tokenFor?.id === c.id && (
              <form
                className="cn-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <label>
                  {c.auth === "oauth2" ? "Access token" : "API token"}
                  <input
                    type="password"
                    aria-label="Connector credential"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Paste the credential"
                    autoComplete="off"
                  />
                </label>
                <label>
                  Account label (optional)
                  <input
                    value={account}
                    onChange={(e) => setAccount(e.target.value)}
                    placeholder="e.g. work account"
                  />
                </label>
                <div className="cn-form-actions">
                  <button type="submit" className="gp-btn" disabled={saving || !token.trim()}>
                    {saving ? "Saving…" : "Save credential"}
                  </button>
                  <button type="button" className="btn btn-quiet btn-sm" onClick={() => setTokenFor(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
