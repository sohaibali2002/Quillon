"use client";

// Govern panel: audit trail, capability grants, durable runs and verification
// reports — the accountability surface. Admins grant and revoke capabilities
// and replay failed runs; everyone signed in can read the trail.
import { useCallback, useEffect, useState } from "react";
import { Pill } from "./ui-bits";

type AuditRow = { id: number; actor: string; action: string; resource: string; detail: Record<string, unknown>; ip: string | null; at: string };
type Capability = { id: string; subject: string; connector: string; action: string; resource: string | null; scope: string; expires_at: string; used_count: number; max_uses: number | null };
type Run = { id: string; kind: string; status: string; attempts: number; max_attempts: number; error: string | null; created_at: string; steps?: { seq: number; name: string; status: string; error: string | null }[] };
type Report = { id: string; targetKind: string; targetName: string; verdict: string; checks: { name: string; verdict: string; detail: string }[]; created_at: string };
type Data = { audit: AuditRow[]; capabilities: Capability[]; runs: Run[]; verifications: Report[]; recovery: { requeued: number; dead: number }; admin: boolean };

const verdictPill = (v: string) => (v === "pass" ? "ok" : v === "warn" ? "warn" : "err");
const runPill = (s: string) => (s === "done" ? "ok" : s === "dead" || s === "error" ? "err" : "warn");

export default function GovernPanel() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ subject: "", connector: "", action: "read", resource: "", ttl: 300 });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/governance");
      if (!res.ok) throw new Error();
      setData((await res.json()) as Data);
      setError(null);
    } catch {
      setError("Could not reach the governance API.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const op = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch("/api/governance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(j.error?.message ?? "Operation failed");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gp-stack">
      <header className="gp-card">
        <div>
          <h2>Govern</h2>
          <p className="gp-fineprint">Audit trail, capability security and durable run recovery.</p>
        </div>
        <div className="gp-row">
          <button className="gp-btn" onClick={() => void load()} disabled={busy}>Refresh</button>
          {data?.recovery.requeued ? <Pill tone="warn">{data.recovery.requeued} recovered</Pill> : null}
          {data?.recovery.dead ? <Pill tone="err">{data.recovery.dead} dead</Pill> : null}
        </div>
      </header>

      {error ? <p className="gp-error" role="alert">{error}</p> : null}
      {!data ? <p className="gp-fineprint">Loading governance data…</p> : null}

      {data ? (
        <>
          <section aria-labelledby="gov-caps">
            <h3 id="gov-caps">Capability security</h3>
            <p className="gp-fineprint">
              Short-lived, narrowly scoped grants. Enforcement happens here, outside the model.
            </p>
            {data.admin ? (
              <form
                className="gp-card gp-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void op({
                    op: "grant",
                    subject: form.subject,
                    connector: form.connector,
                    action: form.action,
                    resource: form.resource || null,
                    ttlSeconds: Number(form.ttl) || 300,
                  });
                }}
              >
                <input aria-label="Subject" placeholder="Subject (agent run id)" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required />
                <input aria-label="Connector" placeholder="Connector" value={form.connector} onChange={(e) => setForm({ ...form, connector: e.target.value })} required />
                <input aria-label="Action" placeholder="Action" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} required />
                <input aria-label="Resource" placeholder="Resource (optional)" value={form.resource} onChange={(e) => setForm({ ...form, resource: e.target.value })} />
                <input aria-label="TTL seconds" type="number" min={10} max={86400} value={form.ttl} onChange={(e) => setForm({ ...form, ttl: Number(e.target.value) })} />
                <button className="gp-btn" type="submit" disabled={busy || !form.subject || !form.connector}>Grant</button>
              </form>
            ) : (
              <p className="gp-fineprint">Only admins can grant or revoke capabilities.</p>
            )}
            {data.capabilities.length ? (
              <ul className="gp-list">
                {data.capabilities.map((c) => (
                  <li key={c.id}>
                    <code>{c.scope}</code>
                    <span className="gp-fineprint"> for {c.subject} · expires {new Date(c.expires_at).toLocaleTimeString()} · used {c.used_count}{c.max_uses !== null ? `/${c.max_uses}` : ""}</span>
                    {data.admin && <button className="gp-btn" onClick={() => void op({ op: "revoke", id: c.id })} disabled={busy}>Revoke</button>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="gp-fineprint">No active capability grants.</p>
            )}
          </section>

          <section aria-labelledby="gov-runs">
            <h3 id="gov-runs">Durable runs</h3>
            <p className="gp-fineprint">Runs survive restarts: completed steps are checkpointed, failed runs can be replayed.</p>
            {data.runs.length ? (
              <ul className="gp-list">
                {data.runs.map((r) => (
                  <li key={r.id}>
                    <Pill tone={runPill(r.status)}>{r.status}</Pill>
                    <span className="gp-fineprint"><code>{r.kind}</code> · attempt {r.attempts}/{r.max_attempts}{r.error ? ` · ${r.error}` : ""}</span>
                    {data.admin && (r.status === "dead" || r.status === "error") && (
                      <button className="gp-btn" onClick={() => void op({ op: "replay", id: r.id })} disabled={busy}>Replay</button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="gp-fineprint">No durable runs yet.</p>
            )}
          </section>

          <section aria-labelledby="gov-verif">
            <h3 id="gov-verif">Verification reports</h3>
            {data.verifications.length ? (
              <ul className="gp-list">
                {data.verifications.map((v) => (
                  <li key={v.id}>
                    <Pill tone={verdictPill(v.verdict)}>{v.verdict}</Pill>
                    <span className="gp-fineprint">{v.targetName} · {v.checks.length} check(s)</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="gp-fineprint">No verification reports yet.</p>
            )}
          </section>

          <section aria-labelledby="gov-audit">
            <h3 id="gov-audit">Audit trail</h3>
            <p className="gp-fineprint">Append-only: who did what, to what, when and from where.</p>
            {data.audit.length ? (
              <ul className="gp-list">
                {data.audit.map((a) => (
                  <li key={a.id}>
                    <span className="gp-fineprint">{new Date(a.at).toLocaleString()} · {a.actor} · <code>{a.action}</code> · {a.resource}{a.ip ? ` · ${a.ip}` : ""}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="gp-fineprint">Nothing audited yet.</p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
