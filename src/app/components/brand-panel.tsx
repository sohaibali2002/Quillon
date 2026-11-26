"use client";

// Brand hub: one kit holds the palette, type pairing, written guidelines,
// voice and logo assets. Everything the Studio generates reads from here.
import { useCallback, useEffect, useRef, useState } from "react";
import { Pill } from "./ui-bits";

type BrandKit = {
  id: string;
  name: string;
  colors: { accent?: string; text?: string; background?: string; muted?: string };
  fonts: { heading?: string; body?: string };
  guidelines: string;
  voice: string;
  updatedAt: string;
  assets: { id: string; name: string; kind: string; mime: string }[];
};

const empty = { name: "", colors: { accent: "#0F6B5C", text: "#1F2937" }, fonts: { heading: "Inter", body: "Inter" }, guidelines: "", voice: "" };

export default function BrandPanel() {
  const [kits, setKits] = useState<BrandKit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(empty);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cloneMsg, setCloneMsg] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/brand");
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { kits: BrandKit[] };
      setKits(data.kits);
      setError(null);
    } catch {
      setError("Could not reach the brand API.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!draft.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/brand", {
        method: editingId ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(editingId ? { ...draft, id: editingId } : draft),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        throw new Error(d.error ?? "Save failed");
      }
      setDraft(empty);
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setSaving(true);
    try {
      await fetch(`/api/brand?kitId=${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    } finally {
      setSaving(false);
    }
  }

  function edit(kit: BrandKit) {
    setEditingId(kit.id);
    setDraft({
      name: kit.name,
      colors: { accent: kit.colors.accent ?? "#0F6B5C", text: kit.colors.text ?? "#1F2937" },
      fonts: { heading: kit.fonts.heading ?? "Inter", body: kit.fonts.body ?? "Inter" },
      guidelines: kit.guidelines,
      voice: kit.voice,
    });
  }

  async function clone(file: File) {
    setCloning(true);
    setCloneMsg(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/brand", { method: "POST", body: form });
      const data = (await res.json()) as { cloned?: { kind: string; colors: Record<string, string>; fonts: { heading?: string; body?: string } }; error?: string };
      if (!res.ok || !data.cloned) throw new Error(data.error ?? "Clone failed");
      setCloneMsg(`Cloned ${data.cloned.kind.toUpperCase()} theme: accent ${Object.values(data.cloned.colors)[0] ?? "?"}${data.cloned.fonts.heading ? `, heading ${data.cloned.fonts.heading}` : ""}. Saved to the template library.`);
      await load();
    } catch (e) {
      setCloneMsg(e instanceof Error ? e.message : "Clone failed.");
    } finally {
      setCloning(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="gp-stack">
      {error && (
        <p className="gp-error" role="alert">
          {error}
        </p>
      )}

      <section className="gp-card" aria-labelledby="bh-clone">
        <h3 id="bh-clone">Clone a template</h3>
        <p className="gp-fineprint">
          Upload an existing .pptx, .docx or .xlsx — Quillon unzips it and reads the theme part for the exact
          palette, fonts and slide size, then saves it as a reusable template.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".pptx,.docx,.xlsx"
          aria-label="Office file to clone"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void clone(f);
          }}
          disabled={cloning}
        />
        {cloning && <Pill tone="run">Reading theme…</Pill>}
        {cloneMsg && <Pill tone="ok">{cloneMsg}</Pill>}
      </section>

      <form
        className="gp-card gp-grid2"
        aria-labelledby="bh-new"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h3 id="bh-new">{editingId ? "Edit brand kit" : "New brand kit"}</h3>
        <label>
          Kit name
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Acme Corp" required />
        </label>
        <label>
          Accent
          <input type="color" value={draft.colors.accent ?? "#0F6B5C"} onChange={(e) => setDraft({ ...draft, colors: { ...draft.colors, accent: e.target.value } })} />
        </label>
        <label>
          Text colour
          <input type="color" value={draft.colors.text ?? "#1F2937"} onChange={(e) => setDraft({ ...draft, colors: { ...draft.colors, text: e.target.value } })} />
        </label>
        <label>
          Heading font
          <input value={draft.fonts.heading ?? ""} onChange={(e) => setDraft({ ...draft, fonts: { ...draft.fonts, heading: e.target.value } })} placeholder="Inter" />
        </label>
        <label>
          Body font
          <input value={draft.fonts.body ?? ""} onChange={(e) => setDraft({ ...draft, fonts: { ...draft.fonts, body: e.target.value } })} placeholder="Inter" />
        </label>
        <label className="gp-span2">
          Guidelines
          <textarea rows={3} value={draft.guidelines} onChange={(e) => setDraft({ ...draft, guidelines: e.target.value })} placeholder="Logo clearspace: half the mark's height on all sides. Accent only on headings and CTAs." />
        </label>
        <label className="gp-span2">
          Voice
          <textarea rows={2} value={draft.voice} onChange={(e) => setDraft({ ...draft, voice: e.target.value })} placeholder="Confident, plain-spoken, no exclamation marks." />
        </label>
        <div className="gp-row">
          <button type="submit" className="gp-btn" disabled={saving || !draft.name.trim()}>
            {saving ? "Saving…" : editingId ? "Update kit" : "Create kit"}
          </button>
          {editingId && (
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={() => {
                setEditingId(null);
                setDraft(empty);
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      {!kits && !error && <p className="gp-fineprint">Loading kits…</p>}
      {kits?.length === 0 && (
        <p className="gp-fineprint">No kits yet. Create one above, or clone an existing Office file to seed the palette automatically.</p>
      )}
      {kits?.map((kit) => (
        <article key={kit.id} className="gp-card" aria-label={`Brand kit ${kit.name}`}>
          <header className="gp-row" style={{ justifyContent: "space-between" }}>
            <h3>{kit.name}</h3>
            <div className="gp-row">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => edit(kit)}>
                Edit
              </button>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => void remove(kit.id)} disabled={saving}>
                Delete
              </button>
            </div>
          </header>
          <div className="gp-row" aria-label={`${kit.name} palette`}>
            {Object.entries(kit.colors).length === 0 && <Pill tone="idle">No colors saved</Pill>}
            {Object.entries(kit.colors).map(([k, v]) => (
              <span key={k} className="gp-row" title={`${k}: ${v}`}>
                <span className="gp-swatch" style={{ background: v ?? "#ccc" }} aria-hidden="true" />
                <small>{v}</small>
              </span>
            ))}
          </div>
          <p className="gp-fineprint">
            {[kit.fonts.heading, kit.fonts.body].filter(Boolean).join(" / ") || "No fonts saved"}
          </p>
          {kit.guidelines && <p>{kit.guidelines}</p>}
          {kit.voice && <p className="gp-fineprint">Voice: {kit.voice}</p>}
        </article>
      ))}
    </div>
  );
}
