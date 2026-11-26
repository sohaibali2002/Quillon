// Agent skills: markdown capability files loaded from the skills/ directory.
// A skill is frontmatter (name, description) plus instruction body; enabled
// skills are injected into the system prompt of chat and agent routes.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const SKILLS_DIR = path.join(process.cwd(), "skills");

export type Skill = {
  id: string;
  name: string;
  description: string;
  content: string;
};

function parseSkill(id: string, raw: string): Skill {
  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(raw);
  const meta: Record<string, string> = {};
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = /^(\w[\w-]*):\s*(.+)$/.exec(line.trim());
      if (m) meta[m[1].toLowerCase()] = m[2].trim();
    }
  }
  return {
    id,
    name: meta.name ?? id,
    description: meta.description ?? "",
    content: raw.slice(fm ? fm[0].length : 0).trim(),
  };
}

export async function listSkills(): Promise<Skill[]> {
  let files: string[] = [];
  try {
    files = (await readdir(SKILLS_DIR)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const skills = await Promise.all(
    files.map(async (f) =>
      parseSkill(f.replace(/\.md$/, ""), await readFile(path.join(SKILLS_DIR, f), "utf8")),
    ),
  );
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getSkill(id: string): Promise<Skill | null> {
  if (!/^[\w-]+$/.test(id)) return null;
  try {
    return parseSkill(id, await readFile(path.join(SKILLS_DIR, `${id}.md`), "utf8"));
  } catch {
    return null;
  }
}

// System prompt block for a set of enabled skill ids. Unknown ids are skipped.
export async function skillsContext(ids: string[]): Promise<string> {
  const wanted = await Promise.all(ids.map((id) => getSkill(id)));
  const active = wanted.filter((s): s is Skill => s !== null);
  if (active.length === 0) return "";
  return [
    "Active skills — follow these instructions when they apply:",
    ...active.map((s) => `## Skill: ${s.name}\n${s.content}`),
  ].join("\n\n");
}
