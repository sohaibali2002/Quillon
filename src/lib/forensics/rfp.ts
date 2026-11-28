// RFP criteria extraction.
//
// Sections L and M become a checkable list: evaluation factors, subfactors,
// proposal instructions and shall-requirements, each with the section it came
// from. The twin evaluates only against these, so a finding can never rest on a
// criterion the solicitation does not state.

import type { Criterion } from "./types";

function cleanLine(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\s*(?:\d+(?:\.\d+)*|[A-Za-z])[.)]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sectionSlice(text: string, startPattern: RegExp, endPattern: RegExp): string {
  const start = startPattern.exec(text);
  if (!start) return "";
  const from = start.index;
  const rest = text.slice(from + start[0].length);
  const end = endPattern.exec(rest);
  return end ? rest.slice(0, end.index) : rest.slice(0, 40_000);
}

const HEADING = /^#{1,6}\s+(.+)$/;
const NUMBERED = /^\s*(\d+(?:\.\d+)*)[.)]?\s+(.{3,120})$/;
const LETTERED = /^\s*([a-z])[.)]\s+(.{3,120})$/i;

/** Pull evaluation factors and subfactors out of Section M. */
export function extractCriteria(rfp: string): Criterion[] {
  const criteria: Criterion[] = [];
  const sectionM = sectionSlice(rfp, /section\s+m\b[^\n]*|evaluation factors?(?: and subfactors?)?\s*$/im, /section\s+n\b|section\s+l\b|attachments?\b/i);
  const body = sectionM || rfp;
  const seen = new Set<string>();
  let index = 0;
  let depth = 0;

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const heading = HEADING.exec(line);
    const numbered = NUMBERED.exec(line);
    if (!heading && !numbered) continue;
    const label = cleanLine(heading?.[1] ?? numbered?.[2] ?? "");
    if (label.length < 3 || label.length > 120) continue;
    if (/^(section|attachment|table of contents|introduction|summary)\b/i.test(label)) continue;
    if (seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    if (numbered) {
      depth = (numbered[1] ?? "").split(".").length;
    } else {
      depth = 1;
    }
    index++;
    criteria.push({
      id: `M-${index}`,
      factor: label,
      section: `M.${index}`,
      text: label,
      kind: depth > 1 ? "subfactor" : "factor",
    });
    if (criteria.length >= 60) break;
  }

  // A prose fallback: "The evaluation factors are X, Y, and Z."
  if (criteria.length === 0) {
    const match = /evaluation factors?(?: are| include| were)\s*:?\s*([^.]{10,400})\./i.exec(body);
    if (match?.[1]) {
      const parts = match[1]
        .split(/;|,|\band\b/)
        .map((p) => p.replace(/^\s*(?:the|a|an)\s+/i, "").trim())
        .filter((p) => p.length >= 3 && p.length <= 80);
      parts.forEach((factor, i) => {
        criteria.push({ id: `M-${i + 1}`, factor, section: `M.${i + 1}`, text: factor, kind: "factor" });
      });
    }
  }

  const sectionL = sectionSlice(rfp, /section\s+l\b[^\n]*|instructions?,? conditions and notices/i, /section\s+m\b|attachments?\b/i);
  if (sectionL) {
    const instructions = sectionL
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /\b(shall|must)\b/i.test(l) && l.length >= 20 && l.length <= 400)
      .slice(0, 40);
    instructions.forEach((text, i) => {
      criteria.push({
        id: `L-${i + 1}`,
        factor: "Section L instruction",
        section: `L.${i + 1}`,
        text,
        kind: "instruction",
      });
    });
  }

  return criteria;
}

/** Group criteria by factor for panel routing. */
export function factorsOf(criteria: Criterion[]): string[] {
  const factors = criteria.filter((c) => c.kind === "factor" || c.kind === "subfactor").map((c) => c.factor);
  return [...new Set(factors)];
}
