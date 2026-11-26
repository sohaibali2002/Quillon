"use client";

// Cloud computers + quick setup: register remote machines (GPU boxes, bastions,
// self-hosted runners) and see exactly what is configured and what is missing.
import { useCallback, useEffect, useState } from "react";
import { Pill } from "./ui-bits";

type Computer = { id: string; name: string; provider: string; host: string; user: string; workdir: string; status: string; lastCheckedAt: string | null };
type SetupCheck = { key: string; label: string; done: boolean; how: string };
type Setup = {
  checks: SetupCheck[];
  steps: { title: string; body: string; href: string; done: boolean }[];
  quickstart: { ollama: string; env: string; docker: string };
};

export default function SetupPanel() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [computers, setComputers] = useState<Computer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", host: "", user: "ubuntu", provider: "ssh", workdir: "/home/ubuntu/quillon" });

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([fetch("/api/setup"), fetch("/api/computers")]);
      if (!s.ok || !c.ok) throw new Error();
      setSetup((await s.json()) as Setup);
      setComputers(((await c.json()) as { computers: Computer[] }).computers);
      setError(null);
    } catch {
      setError("Could not reach the setup API.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (!draft.name.trim() || !draft.host.trim()) return;
    setBusy("add");
    try {
      await fetch("/api/computers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) });
      setDraft({ ...draft, name: "", host: "" });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function check(c: Computer) {
    setBusy(c.id);
    try {
      await fetch("/api/computers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ checkId: c.id }) });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function remove(c: Computer) {
    setBusy(c.id);
    try {
      await fetch(`/api/computers?computerId=${encodeURIComponent(c.id)}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="gp-stack">
      {error && (
        <p className="gp-error" role="alert">
          {error}
        </p>
      )}

      <section className="gp-card" aria-labelledby="sp-steps">
        <h3 id="sp-steps">Quick setup</h3>
        <ol>
          {(setup?.steps ?? []).map((s) => (
            <li key={s.title}>
              <b>{s.title}</b>
              {s.done ? <Pill tone="ok">done</Pill> : null}
              <p className="gp-fineprint">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="gp-card" aria-labelledby="sp-checks">
        <h3 id="sp-checks">Configuration</h3>
        <ul className="gp-fineprint">
          {(setup?.checks ?? []).map((c) => (
            <li key={c.key}>
              {c.done ? <Pill tone="ok">ready</Pill> : <Pill tone="warn">open</Pill>} <b>{c.label}</b> — {c.how}
            </li>
          ))}
        </ul>
        {setup && (
          <details>
            <summary>Quickstart commands</summary>
            <pre>{setup.quickstart.ollama}</pre>
            <pre>{setup.quickstart.env}</pre>
            <pre>{setup.quickstart.docker}</pre>
          </details>
        )}
      </section>

      <form
        className="gp-card gp-grid2"
        aria-labelledby="sp-comp"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <h3 id="sp-comp">Cloud computers</h3>
        <label>
          Name
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Vast H100" required />
        </label>
        <label>
          Host
          <input value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })} placeholder="203.0.113.10 or gpu.internal" required />
        </label>
        <label>
          User
          <input value={draft.user} onChange={(e) => setDraft({ ...draft, user: e.target.value })} />
        </label>
        <label>
          Provider
          <select value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value })}>
            <option value="ssh">SSH</option>
            <option value="vast">Vast</option>
            <option value="runpod">RunPod</option>
            <option value="lambda">Lambda</option>
          </select>
        </label>
        <div className="gp-row gp-span2">
          <button type="submit" className="gp-btn" disabled={busy === "add" || !draft.name.trim() || !draft.host.trim()}>
            Add computer
          </button>
        </div>
      </form>

      <ul className="gp-list" aria-label="Registered computers">
        {(computers ?? []).map((c) => (
          <li key={c.id} className="gp-card">
            <div className="gp-row" style={{ justifyContent: "space-between" }}>
              <div>
                <b>{c.name}</b>
                <p className="gp-fineprint">
                  {c.user}@{c.host} · {c.provider} · {c.workdir}
                </p>
              </div>
              <div className="gp-row">
                <Pill tone={c.status === "online" ? "ok" : c.status === "offline" ? "err" : "idle"}>{c.status}</Pill>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void check(c)} disabled={busy === c.id}>
                  Check
                </button>
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => void remove(c)} disabled={busy === c.id}>
                  Remove
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {computers?.length === 0 && <p className="gp-fineprint">No computers registered. Add one to dispatch unattended jobs to your own hardware.</p>}
    </div>
  );
}
