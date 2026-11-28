// Approval-gated outbound actions for Evaluation Forensics.
//
// Nothing here contacts an agency or files anything. The two consequential
// actions the module offers — a counsel export package and a debrief-request
// draft — are transactions: planned, simulated, approved by a human, then
// executed as local files, with undo and verification. Registration is
// idempotent so both the route and the tool builder can call it.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerActionType } from "@/lib/transaction";
import { getDebriefRun } from "./store";

const EXPORT_DIR = join(process.cwd(), ".data", "forensics-exports");
let registered = false;

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "tenant";
}

function exportPath(tenant: string, name: string): string {
  return join(EXPORT_DIR, safeName(tenant), safeName(name));
}

export function registerForensicsActions(): void {
  if (registered) return;
  registered = true;

  registerActionType("forensics.counsel_export", {
    simulate: async (payload) => {
      const tenant = String(payload.tenant ?? "");
      const runId = String(payload.runId ?? "");
      const report = getDebriefRun(tenant, runId);
      return {
        action: "Write a counsel export package to the local exports folder",
        findings: report.findings.length,
        issues: report.issues.length,
        outbound: false,
      };
    },
    execute: async (payload) => {
      const tenant = String(payload.tenant ?? "");
      const runId = String(payload.runId ?? "");
      const report = getDebriefRun(tenant, runId);
      const pkg = {
        kind: "quillon.forensics.counsel_package",
        version: 1,
        generated_at: new Date().toISOString(),
        report,
        standard_of_review: report.standardOfReview,
        disclaimer: report.disclaimer,
      };
      const file = exportPath(tenant, `counsel-package-${runId}.json`);
      mkdirSync(join(EXPORT_DIR, safeName(tenant)), { recursive: true });
      writeFileSync(file, JSON.stringify(pkg, null, 2), "utf8");
      return { path: file, findings: report.findings.length, bytes: JSON.stringify(pkg).length };
    },
    verify: async (_payload, result) => {
      const file = (result as { path?: string } | null)?.path;
      if (!file) return false;
      try {
        return JSON.parse(readFileSync(file, "utf8")).kind === "quillon.forensics.counsel_package";
      } catch {
        return false;
      }
    },
    undo: async (_payload, result) => {
      const file = (result as { path?: string } | null)?.path;
      if (!file) return;
      try {
        rmSync(file);
      } catch {
        // already gone
      }
    },
  });

  registerActionType("forensics.debrief_request_draft", {
    simulate: async (payload) => ({
      action: "Write a debrief-request draft to the local exports folder",
      outbound: false,
      noticeDate: payload.noticeDate ?? null,
    }),
    execute: async (payload) => {
      const tenant = String(payload.tenant ?? "");
      const pursuitId = String(payload.pursuitId ?? "pursuit");
      const text = String(payload.draftText ?? "");
      if (text.trim().length < 40) throw new Error("The draft is empty.");
      const file = exportPath(tenant, `debrief-request-${pursuitId}.md`);
      mkdirSync(join(EXPORT_DIR, safeName(tenant)), { recursive: true });
      writeFileSync(
        file,
        `<!-- Quillon draft. Not sent. Review with counsel before any communication with the contracting officer. -->\n\n${text}\n`,
        "utf8",
      );
      return { path: file };
    },
    verify: async (_payload, result) => {
      const file = (result as { path?: string } | null)?.path;
      if (!file) return false;
      try {
        return readFileSync(file, "utf8").includes("Quillon draft");
      } catch {
        return false;
      }
    },
    undo: async (_payload, result) => {
      const file = (result as { path?: string } | null)?.path;
      if (!file) return;
      try {
        rmSync(file);
      } catch {
        // already gone
      }
    },
  });
}
