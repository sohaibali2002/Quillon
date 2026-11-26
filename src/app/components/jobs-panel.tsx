"use client";

// Unattended work: industry packages seed scheduled jobs; each job keeps a run
// history with status, duration and output.
import { useCallback, useEffect, useState } from "react";
import { Pill, formatMs } from "./ui-bits";

type SeedJob = { name: string; prompt: string; schedule: string; seeded?: boolean };
type Package = { id: string; name: string; tagline: string; category: string; capabilities: string[]; seedJobs?: SeedJob[] };
type Job = { id: string; name: string; prompt: string; schedule: string; enabled: boolean; lastRunAt: string | null; nextRunAt: string | null };
type Run = { id: string; status: "running" | "done" | "error"; output: string; error: string | null; durationMs: number | null; startedAt: string };

export default function JobsPanel() {
  const [packages, setPackages] = useState<Package[] | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [newJob, setNewJob] = useState({ name: "", prompt: "", schedule: "daily" });

  const load = useCallback(async () => {
    try {
      const [p, j] = await Promise.all([fetch("/api/packages"), fetch("/api/jobs")]);
      if (!p.ok || !j.ok) throw new Error();
      setPackages(((await p.json()) as { packages: Package[] }).packages);
      setJobs(((await j.json()) as { jobs: Job[] }).jobs);
      setError(null);
    } catch {
      setError("Could not reach the jobs API.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function seed(pkg: Package) {
    setBusy(pkg.id);
    try {
      await fetch("/api/packages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ packageId: pkg.id }) });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function toggle(job: Job) {
    setBusy(job.id);
    try {
      await fetch("/api/jobs", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: job.id, enabled: !job.enabled }) });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function runNow(job: Job) {
    setBusy(job.id);
    setError(null);
    try {
      const res = await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: job.id }) });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        throw new Error(d.error ?? "Run failed");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Run failed.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(job: Job) {
    setBusy(job.id);
    try {
      await fetch(`/api/jobs?jobId=${encodeURIComponent(job.id)}`, { method: "DELETE" });
      if (runsFor === job.id) {
        setRunsFor(null);
        setRuns(null);
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function showRuns(job: Job) {
    setBusy(job.id);
    try {
      const res = await fetch(`/api/jobs?jobId=${encodeURIComponent(job.id)}`);
      setRuns(((await res.json()) as { runs: Run[] }).runs);
      setRunsFor(runsFor === job.id ? null : job.id);
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    if (!newJob.name.trim() || !newJob.prompt.trim()) return;
    setBusy("new");
    try {
      await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(newJob) });
      setNewJob({ name: "", prompt: "", schedule: "daily" });
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

      <section aria-labelledby="jb-pkgs">
        <h3 id="jb-pkgs">Industry packages</h3>
        <p className="gp-fineprint">Enable a package to seed its watchlists and briefs as scheduled unattended jobs.</p>
        <ul className="gp-list">
          {(packages ?? []).map((p) => (
            <li key={p.id} className="gp-card">
              <div className="gp-row" style={{ justifyContent: "space-between" }}>
                <div>
                  <b>{p.name}</b>
                  <p className="gp-fineprint">{p.tagline}</p>
                </div>
                {p.seedJobs?.length ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void seed(p)} disabled={busy === p.id}>
                    {p.seedJobs.every((j) => j.seeded) ? "Re-seed jobs" : "Enable package"}
                  </button>
                ) : null}
              </div>
              <ul className="gp-fineprint">
                {p.capabilities.slice(0, 3).map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>

      <form
        className="gp-card gp-grid2"
        aria-labelledby="jb-new"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <h3 id="jb-new">New unattended job</h3>
        <label>
          Name
          <input value={newJob.name} onChange={(e) => setNewJob({ ...newJob, name: e.target.value })} placeholder="Overnight pipeline summary" required />
        </label>
        <label>
          Schedule
          <select value={newJob.schedule} onChange={(e) => setNewJob({ ...newJob, schedule: e.target.value })}>
            <option value="manual">Manual</option>
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>
        <label className="gp-span2">
          Prompt
          <textarea rows={3} value={newJob.prompt} onChange={(e) => setNewJob({ ...newJob, prompt: e.target.value })} placeholder="Summarise yesterday's support tickets by theme and flag anything with SLA risk." required />
        </label>
        <button type="submit" className="gp-btn" disabled={busy === "new" || !newJob.name.trim() || !newJob.prompt.trim()}>
          Create job
        </button>
      </form>

      <section aria-labelledby="jb-list">
        <h3 id="jb-list">Jobs</h3>
        {!jobs?.length && <p className="gp-fineprint">No jobs yet — enable a package above or create one.</p>}
        <ul className="gp-list">
          {(jobs ?? []).map((j) => (
            <li key={j.id} className="gp-card">
              <div className="gp-row" style={{ justifyContent: "space-between" }}>
                <div>
                  <b>{j.name}</b>
                  <p className="gp-fineprint">
                    {j.schedule} · last run {j.lastRunAt ? new Date(j.lastRunAt).toLocaleString() : "never"}
                    {j.nextRunAt && j.enabled ? ` · next ${new Date(j.nextRunAt).toLocaleString()}` : ""}
                  </p>
                </div>
                <div className="gp-row">
                  {j.enabled ? <Pill tone="ok">On</Pill> : <Pill tone="idle">Paused</Pill>}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void runNow(j)} disabled={busy === j.id}>
                    Run now
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void toggle(j)} disabled={busy === j.id}>
                    {j.enabled ? "Pause" : "Resume"}
                  </button>
                  <button type="button" className="btn btn-quiet btn-sm" onClick={() => void showRuns(j)} disabled={busy === j.id} aria-expanded={runsFor === j.id}>
                    History
                  </button>
                  <button type="button" className="btn btn-quiet btn-sm" onClick={() => void remove(j)} disabled={busy === j.id}>
                    Delete
                  </button>
                </div>
              </div>
              {runsFor === j.id && runs && (
                <div className="gp-fineprint" aria-label={`Runs for ${j.name}`}>
                  {runs.length === 0 && <p>No runs yet.</p>}
                  {runs.map((r) => (
                    <p key={r.id}>
                      <Pill tone={r.status === "done" ? "ok" : r.status === "error" ? "err" : "run"}>{r.status}</Pill>{" "}
                      {new Date(r.startedAt).toLocaleString()}
                      {r.durationMs != null ? ` · ${formatMs(r.durationMs)}` : ""}
                      {r.status === "error" && r.error ? ` — ${r.error}` : r.status === "done" ? ` — ${r.output.slice(0, 140)}${r.output.length > 140 ? "…" : ""}` : ""}
                    </p>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
