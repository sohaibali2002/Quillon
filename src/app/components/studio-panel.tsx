"use client";

// Document studio: standard templates (filled in and generated on-brand) plus
// the cloned-template library.
import { useCallback, useEffect, useState } from "react";
import { Pill } from "./ui-bits";

type Field = { key: string; label: string; placeholder: string; multiline?: boolean };
type Builtin = { id: string; name: string; kind: "pptx" | "docx" | "xlsx"; category: string; description: string; fields: Field[] };
type Cloned = { id: string; name: string; kind: "pptx" | "docx" | "xlsx"; source: string; definition: { colors?: Record<string, string> } };
type Kit = { id: string; name: string };

export default function StudioPanel() {
  const [builtin, setBuiltin] = useState<Builtin[] | null>(null);
  const [cloned, setCloned] = useState<Cloned[] | null>(null);
  const [kits, setKits] = useState<Kit[]>([]);
  const [selected, setSelected] = useState<Builtin | Cloned | null>(null);
  const [kitId, setKitId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ filename: string; fileDataUrl: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([fetch("/api/studio"), fetch("/api/brand")]);
      if (!s.ok || !b.ok) throw new Error();
      const sd = (await s.json()) as { builtin: Builtin[]; cloned: Cloned[] };
      const bd = (await b.json()) as { kits: Kit[] };
      setBuiltin(sd.builtin);
      setCloned(sd.cloned);
      setKits(bd.kits);
      setError(null);
    } catch {
      setError("Could not reach the studio API.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function generate() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/studio", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateId: selected.id, kitId: kitId || null, input: values }),
      });
      const data = (await res.json()) as { filename?: string; fileDataUrl?: string; error?: string };
      if (!res.ok || !data.filename || !data.fileDataUrl) throw new Error(data.error ?? "Generation failed");
      setResult({ filename: data.filename, fileDataUrl: data.fileDataUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed.");
    } finally {
      setBusy(false);
    }
  }

  const kindLabel = (k: string) => (k === "pptx" ? "Deck" : k === "docx" ? "Document" : "Workbook");

  return (
    <div className="gp-stack">
      {error && (
        <p className="gp-error" role="alert">
          {error}
        </p>
      )}

      <p className="gp-fineprint">
        Every generated file takes colors, fonts and masthead from the brand kit you pick here, so the output is
        on-brand without hand-styling.
      </p>

      <label>
        Brand kit
        <select value={kitId} onChange={(e) => setKitId(e.target.value)}>
          <option value="">Quillon default</option>
          {kits.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
      </label>

      <section aria-labelledby="st-std">
        <h3 id="st-std">Standard templates</h3>
        <ul className="gp-list">
          {(builtin ?? []).map((t) => (
            <li key={t.id}>
              <button type="button" className="gp-toolcard" aria-pressed={selected?.id === t.id} onClick={() => { setSelected(t); setValues({}); setResult(null); }}>
                <b>{t.name}</b>
                <span>{t.description}</span>
                <small>{kindLabel(t.kind)}</small>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="st-cloned">
        <h3 id="st-cloned">Cloned templates</h3>
        {!cloned?.length && <p className="gp-fineprint">Nothing cloned yet — upload a .pptx or .docx in the Brand hub to capture its exact theme.</p>}
        <ul className="gp-list">
          {(cloned ?? []).map((t) => (
            <li key={t.id}>
              <button type="button" className="gp-toolcard" aria-pressed={selected?.id === t.id} onClick={() => { setSelected(t); setValues({}); setResult(null); }}>
                <b>{t.name}</b>
                <span>Cloned theme with {Object.keys(t.definition?.colors ?? {}).length} colors.</span>
                <small>{kindLabel(t.kind)} · cloned</small>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {selected && (
        <form
          className="gp-card gp-grid2"
          aria-label={`Generate ${selected.name}`}
          onSubmit={(e) => {
            e.preventDefault();
            void generate();
          }}
        >
          <h3>{selected.name}</h3>
          {"fields" in selected ? (
            selected.fields.map((f) => (
              <label key={f.key} className={f.multiline ? "gp-span2" : undefined}>
                {f.label}
                {f.multiline ? (
                  <textarea rows={3} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} placeholder={f.placeholder} />
                ) : (
                  <input value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} placeholder={f.placeholder} />
                )}
              </label>
            ))
          ) : (
            <label className="gp-span2">
              Topic or summary
              <textarea rows={3} value={values.summary ?? ""} onChange={(e) => setValues({ ...values, summary: e.target.value })} placeholder="What should this cover?" />
            </label>
          )}
          <div className="gp-row gp-span2">
            <button type="submit" className="gp-btn" disabled={busy}>
              {busy ? "Generating…" : "Generate"}
            </button>
            {result && (
              <a className="gp-btn" href={result.fileDataUrl} download={result.filename}>
                Download {result.filename}
              </a>
            )}
          </div>
          {busy && <Pill tone="run">Building the file…</Pill>}
          {result && <Pill tone="ok">Ready — {result.filename}</Pill>}
        </form>
      )}
    </div>
  );
}
