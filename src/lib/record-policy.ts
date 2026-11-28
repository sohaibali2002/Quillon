// Record-level policy for ERP and CRM writes.
//
// The role model (viewer / member / admin) is coarse: a member needs to update
// opportunities and support tickets, but the same connector can also rewrite a
// payroll record, an employee's bank details or the journal. This layer looks at
// what a write actually touches — the record type in the tool input and the
// field names in its payload — and refuses sensitive records and fields for
// anything below administrator.
//
// QUILLON_RECORD_ALLOW="netsuite:vendorpayment,employee.salary" re-opens named
// records or fields for members of a deployment that deliberately trusts them.
import type { Role } from "@/lib/rbac";

/** Connectors whose records carry employment, payroll and finance data. */
const RESTRICTED_CONNECTORS = new Set(["salesforce", "hubspot", "netsuite", "costpoint"]);

/** Record types a member may not write, per connector. */
const RESTRICTED_RECORDS: Record<string, string[]> = {
  salesforce: [
    "user",
    "userrole",
    "permissionset",
    "permissionsetassignment",
    "permissionsetgroup",
    "profile",
    "groupmember",
    "accountteammember",
    "territory2",
    "employee",
    "payroll",
    "credential",
    "namedcredential",
  ],
  netsuite: [
    "employee",
    "employeebulkupload",
    "payrollitem",
    "payrollbatch",
    "vendor",
    "vendorpayment",
    "billpayment",
    "journalentry",
    "deposit",
    "transfer",
    "budgetexchange",
    "accountingperiod",
    "role",
    "customrole",
    "subsidiary",
  ],
  costpoint: ["labor", "payroll", "employee", "vendor", "journal", "gl", "account", "ap", "ar"],
  hubspot: ["owner", "user", "team", "property", "pipeline", "integration"],
};

/** Payload fields that are never a member's to write, on any connector. */
const RESTRICTED_FIELDS =
  /^(salary|compensation|bonus|payroll|ssn|social_security(_number)?|national_id|passport(_number)?|bank_account(_number)?|routing_number|iban|tax_id|vat_number|credit_card(_number)?|card_number|cvv|password|password_hash|secret|api_key|medical|health|disability|ethnicity|religion|date_of_birth|dob|biometric)$/;

function tokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function collect(value: unknown, depth = 0, keys: string[] = [], strings: string[] = []): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value.length <= 200) strings.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) collect(item, depth + 1, keys, strings);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    keys.push(key);
    collect(inner, depth + 1, keys, strings);
  }
}

function allowedByOperator(connector: string, needle: string): boolean {
  return (process.env.QUILLON_RECORD_ALLOW ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => entry === needle || entry === `${connector}:${needle}`);
}

/**
 * Why this write is not allowed for the role, or null when it may proceed.
 * Reads are never restricted here; the authority table settles those.
 */
export function recordPolicyReason(
  connector: string | undefined,
  action: string,
  input: unknown,
  role: Role,
): string | null {
  if (!connector || role === "admin") return null;
  if (!RESTRICTED_CONNECTORS.has(connector)) return null;

  const keys: string[] = [];
  const strings: string[] = [];
  collect(input, 0, keys, strings);

  const records = RESTRICTED_RECORDS[connector] ?? [];
  for (const raw of [...keys, ...strings]) {
    for (const token of tokens(raw)) {
      if (!records.includes(token)) continue;
      if (allowedByOperator(connector, token)) continue;
      return `${connector} ${token} records are restricted to administrators; "${action}" would write one.`;
    }
  }

  for (const key of keys) {
    for (const token of tokens(key)) {
      if (!RESTRICTED_FIELDS.test(token)) continue;
      if (allowedByOperator(connector, token)) continue;
      return `The field "${key}" is restricted to administrators; "${action}" would write it.`;
    }
  }
  return null;
}
