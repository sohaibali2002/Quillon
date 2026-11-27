// Agent skills: markdown capability files loaded from the skills/ directory.
// A skill is frontmatter (name, description) plus instruction body; enabled
// skills are injected into the system prompt of chat and agent routes.
//
// Skills are read from disk once and cached in-process (listSkills runs on
// every chat request, and on a network-mounted skills dir a full re-read per
// message is measurable). The cache is short-lived so edited files are picked
// up quickly, and content is capped so one huge skill file cannot flood the
// prompt.
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const SKILLS_DIR = path.join(process.cwd(), "skills");
const CACHE_TTL_MS = 30_000;
const MAX_SKILL_CHARS = 4_000;
const MAX_SKILL_FILE_BYTES = 256 * 1024;

export type Skill = {
  id: string;
  name: string;
  description: string;
  content: string;
};

// --- Frontmatter -------------------------------------------------------------
// A small, strict YAML-subset reader for the fields skills use (name,
// description). Handles quoted values, folded/literal scalars (`>` / `|`) and
// ignores anything nested, instead of the old regex-per-line parser that broke
// on quoted colons and multi-line descriptions.
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!fm) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  const lines = fm[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let value = m[2].trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const folded = value.startsWith(">");
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
        block.push(lines[++i].trim());
      }
      value = (folded ? block.join(" ") : block.join("\n")).trim();
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      const quoted = value.slice(1, -1);
      value =
        value.startsWith('"')
          ? quoted.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
          : quoted.replace(/''/g, "'");
    }
    meta[key] = value;
  }
  return { meta, body: raw.slice(fm[0].length) };
}

function parseSkill(id: string, raw: string): Skill {
  const { meta, body } = parseFrontmatter(raw);
  let content = body.trim();
  if (content.length > MAX_SKILL_CHARS) {
    content = `${content.slice(0, MAX_SKILL_CHARS)}\n…[skill truncated at ${MAX_SKILL_CHARS} characters]`;
    console.warn(`skill "${id}" is over ${MAX_SKILL_CHARS} characters and was truncated`);
  }
  return {
    id,
    name: meta.name ?? id,
    description: meta.description ?? "",
    content,
  };
}

// --- Cache -------------------------------------------------------------------
let cache: { at: number; skills: Skill[] } | null = null;

async function loadSkills(): Promise<Skill[]> {
  let files: string[] = [];
  try {
    files = (await readdir(SKILLS_DIR)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const f of files) {
    const file = path.join(SKILLS_DIR, f);
    try {
      const info = await stat(file);
      if (info.size > MAX_SKILL_FILE_BYTES) {
        console.warn(`skill file "${f}" is over ${MAX_SKILL_FILE_BYTES} bytes and was skipped`);
        continue;
      }
      skills.push(parseSkill(f.replace(/\.md$/, ""), await readFile(file, "utf8")));
    } catch {
      // an unreadable skill should not take the others down
    }
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

export async function listSkills(options: { fresh?: boolean } = {}): Promise<Skill[]> {
  if (!options.fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.skills;
  const skills = await loadSkills();
  cache = { at: Date.now(), skills };
  return skills;
}

export async function getSkill(id: string): Promise<Skill | null> {
  if (!/^[\w-]+$/.test(id)) return null;
  const skills = await listSkills();
  const hit = skills.find((s) => s.id === id);
  if (hit) return hit;
  // A skill added since the last load: bypass the cache once.
  return (await listSkills({ fresh: true })).find((s) => s.id === id) ?? null;
}

// System prompt block for a set of enabled skill ids. Unknown ids are skipped.
export async function skillsContext(ids: string[]): Promise<string> {
  if (ids.length === 0) return "";
  const skills = await listSkills();
  const byId = new Map(skills.map((s) => [s.id, s]));
  const active = ids.map((id) => byId.get(id)).filter((s): s is Skill => Boolean(s));
  if (active.length === 0) return "";
  return [
    "Active skills — follow these instructions when they apply:",
    ...active.map((s) => `## Skill: ${s.name}\n${s.content}`),
  ].join("\n\n");
}
