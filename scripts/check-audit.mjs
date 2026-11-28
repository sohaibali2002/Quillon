// Dependency-advisory gate.
//
// Fails on any high or critical advisory in the production dependency tree
// that is not listed in scripts/npm-audit-allow.json with a written reason.
// The allowlist is for advisories we have checked and can argue are not
// reachable from Quillon's own code paths; everything else must be fixed.
//
// Usage: npm run check:audit

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const allowPath = join(here, "npm-audit-allow.json");
const BLOCKING = new Set(["high", "critical"]);

function loadAllowlist() {
  try {
    const raw = JSON.parse(readFileSync(allowPath, "utf8"));
    return new Map((raw.allow ?? []).map((entry) => [entry.advisory, entry]));
  } catch {
    return new Map();
  }
}

function audit() {
  // --report <file> replays a stored `npm audit --json` output, so the gate's
  // failure path can be exercised without waiting for a real advisory.
  const flag = process.argv.indexOf("--report");
  if (flag !== -1 && process.argv[flag + 1]) {
    return JSON.parse(readFileSync(process.argv[flag + 1], "utf8"));
  }
  let out;
  try {
    out = execFileSync("npm", ["audit", "--omit=dev", "--json"], {
      cwd: join(here, ".."),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    // npm audit exits non-zero when it finds anything; the JSON is still on stdout.
    out = err.stdout ?? "";
  }
  return JSON.parse(out || "{}");
}

function advisoriesOf(vuln) {
  const via = Array.isArray(vuln.via) ? vuln.via : [];
  const ids = via
    .filter((v) => v && typeof v === "object")
    .map((v) => v.url ?? v.source ?? v.title)
    .filter(Boolean);
  // A vuln reached only through a vulnerable package (no direct advisory of its
  // own) inherits the advisories of what it depends on; callers pass those down.
  return ids;
}

const allow = loadAllowlist();
const report = audit();
const vulns = report.vulnerabilities ?? {};

const blocking = [];
const accepted = [];
const seen = new Set();

for (const [pkg, vuln] of Object.entries(vulns)) {
  const severity = String(vuln.severity ?? "unknown").toLowerCase();
  if (!BLOCKING.has(severity)) continue;
  const ids = advisoriesOf(vuln);
  if (ids.length === 0) {
    blocking.push({ pkg, severity, ids: [`${pkg} (no advisory id)`], reason: "no allowlist match" });
    continue;
  }
  const missing = ids.filter((id) => !allow.has(id));
  for (const id of ids) seen.add(id);
  if (missing.length === 0) {
    accepted.push({ pkg, severity, ids });
  } else {
    blocking.push({ pkg, severity, ids: missing });
  }
}

for (const id of allow.keys()) {
  if (!seen.has(id)) console.log(`NOTE allowlist entry no longer matches a finding: ${id}`);
}

if (accepted.length) {
  for (const a of accepted) {
    console.log(`ACCEPTED ${a.severity} ${a.pkg} — ${a.ids.map((i) => allow.get(i)?.reason ?? i).join("; ")}`);
  }
}

if (blocking.length) {
  for (const b of blocking) {
    console.error(`FAIL ${b.severity} ${b.pkg}: ${b.ids.join(", ")}`);
  }
  console.error(`\n${blocking.length} unaccepted high/critical advisories.`);
  process.exit(1);
}

const counts = report.metadata?.vulnerabilities ?? {};
console.log(
  `audit gate passed: ${counts.high ?? 0} high, ${counts.critical ?? 0} critical, ${counts.moderate ?? 0} moderate in the production tree; all blocking findings are allowlisted with a reason.`,
);
