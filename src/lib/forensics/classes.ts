// Permission classes for the forensics tools, kept in a pure module so the
// manifest generator can import them without loading the AI SDK or the database.

export const FW_TOOL_CLASSES: Record<string, "read" | "write" | "destructive" | "admin"> = {
  fw_search_precedent: "read",
  fw_ground_statistics: "read",
  fw_verify_quote: "read",
  fw_lint_proposal: "read",
  fw_compute_clock: "read",
  fw_list_clocks: "read",
  fw_list_documents: "read",
  fw_list_runs: "read",
  fw_precedent_for_ground: "read",
  fw_run_twin: "write",
  fw_verify_debrief: "write",
  fw_export_counsel_package: "write",
  fw_draft_debrief_request: "write",
  fw_ingest_decision: "admin",
};
