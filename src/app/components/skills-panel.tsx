"use client";

// Skills desk: the markdown capability files on disk, with their prompt
// bodies. Enabled skills ride along in chat and agent requests.
import { useEffect, useState } from "react";
import { Metric } from "./ui-bits";

type Skill = { id: string; name: string; description: string; content: string };

export default function SkillsPanel() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/skills")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((d: { skills: Skill[] }) => setSkills(d.skills ?? []))
      .catch(() => setError("Could not load skills."));
  }, []);

  return (
    <section className="gp-section">
      <header className="gp-section-head">
        <div>
          <h2>Agent skills</h2>
          <p className="gp-fineprint">
            Markdown files in <code>skills/</code> with frontmatter name and
            description. Pick them per request in the conversation desk; their
            instructions are injected into the system prompt.
          </p>
        </div>
        <div className="gp-metrics">
          <Metric label="Installed" value={skills?.length ?? "…"} hint="Skills on disk" />
        </div>
      </header>

      {error && (
        <p role="alert" className="gp-error">
          {error}
        </p>
      )}
      {skills === null ? (
        <p className="gp-fineprint">Loading skills…</p>
      ) : skills.length === 0 ? (
        <p className="gp-fineprint">
          No skills yet. Add a markdown file to <code>skills/</code> and it shows up here.
        </p>
      ) : (
        <ul className="gp-list">
          {skills.map((s) => (
            <li key={s.id} className="gp-list-row gp-list-column">
              <button
                type="button"
                className="gp-list-main gp-ghost-row"
                aria-expanded={open === s.id}
                onClick={() => setOpen(open === s.id ? null : s.id)}
              >
                <span className="gp-list-text">{s.name}</span>
                <span className="gp-fineprint">
                  {s.description || s.id} · {s.content.length} chars of instructions
                </span>
              </button>
              {open === s.id && (
                <pre className="gp-pre">{s.content}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
