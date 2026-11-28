// Protest clock engine.
//
// Four windows decide whether an offeror keeps its options open: the deadline
// to request a required debriefing, the GAO filing window measured from the
// basis being known or from the debriefing, and the two stay triggers. Each
// computed date carries the rule text and its source, is adjusted to the next
// business day when it lands on a weekend or a Federal holiday, and is marked
// verify-with-counsel — the engine informs, it never decides.

import { CLOCK_DISCLAIMER } from "./types";

export interface ClockInput {
  /** Award or exclusion notice date, YYYY-MM-DD. */
  noticeDate: string;
  /** When the offeror first knew the basis of protest, if earlier/later. */
  basisKnownDate?: string;
  /** Date the debriefing was actually held. */
  debriefDate?: string;
  /** For a solicitation-terms challenge: the date initial proposals are due. */
  proposalsDueDate?: string;
  /** Reference date for status; defaults to today (UTC). */
  now?: string;
}

export type DeadlineStatus = "open" | "due_soon" | "passed" | "not_applicable";

export interface ClockDeadline {
  id: string;
  label: string;
  dueDate: string;
  /** The unadjusted calendar date before the business-day rule. */
  rawDate: string;
  adjusted: boolean;
  basis: string;
  ruleText: string;
  source: string;
  status: DeadlineStatus;
  daysRemaining: number | null;
  verifyWithCounsel: true;
  note?: string;
}

export interface ProtestClock {
  noticeDate: string;
  controllingFilingDeadline: string | null;
  deadlines: ClockDeadline[];
  ruleSources: string[];
  disclaimer: string;
  computedAt: string;
}

function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(value: string, days: number): string {
  const date = parseDate(value);
  if (!date) throw new Error(`Invalid date "${value}"; expected YYYY-MM-DD.`);
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
}

function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
}

function lastWeekday(year: number, month: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month, last.getUTCDate() - offset));
}

function observed(date: Date): Date {
  const day = date.getUTCDay();
  if (day === 6) return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - 1));
  if (day === 0) return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
  return date;
}

const holidayCache = new Map<number, Set<string>>();

/** US Federal holidays that close Federal offices, by observed date. */
export function federalHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const days = [
    observed(new Date(Date.UTC(year, 0, 1))),
    nthWeekday(year, 0, 1, 3),
    nthWeekday(year, 1, 1, 3),
    lastWeekday(year, 4, 1),
    observed(new Date(Date.UTC(year, 5, 19))),
    observed(new Date(Date.UTC(year, 6, 4))),
    nthWeekday(year, 8, 1, 1),
    nthWeekday(year, 9, 1, 2),
    observed(new Date(Date.UTC(year, 10, 11))),
    nthWeekday(year, 10, 4, 4),
    observed(new Date(Date.UTC(year, 11, 25))),
  ];
  const set = new Set(days.map(iso));
  holidayCache.set(year, set);
  return set;
}

export function isBusinessDay(value: string): boolean {
  const date = parseDate(value);
  if (!date) return false;
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  return !federalHolidays(date.getUTCFullYear()).has(value);
}

export function nextBusinessDay(value: string): string {
  let current = value;
  for (let i = 0; i < 10; i++) {
    if (isBusinessDay(current)) return current;
    current = addDays(current, 1);
  }
  return current;
}

function daysBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

interface RuleSpec {
  id: string;
  label: string;
  anchor: keyof ClockInput | null;
  days: number;
  basis: string;
  ruleText: string;
  source: string;
}

const RULES: RuleSpec[] = [
  {
    id: "debrief_request",
    label: "Request a required debriefing",
    anchor: "noticeDate",
    days: 3,
    basis: "Award or exclusion notice",
    ruleText: "A required debriefing must be requested within 3 days after the date the offeror receives notification of award or exclusion.",
    source: "FAR 15.505(a)(1)",
  },
  {
    id: "debrief_filing",
    label: "GAO filing deadline (after a required debriefing)",
    anchor: "debriefDate",
    days: 10,
    basis: "Date the debriefing was held",
    ruleText: "Where a required debriefing is requested and held, a protest must be filed within 10 calendar days after the debriefing date.",
    source: "4 C.F.R. § 21.2(a)(3)",
  },
  {
    id: "basis_filing",
    label: "GAO filing deadline (basis known, no debriefing)",
    anchor: "basisKnownDate",
    days: 10,
    basis: "Date the basis of protest was known",
    ruleText: "A protest must be filed within 10 calendar days after the protester knew or should have known the basis of protest.",
    source: "4 C.F.R. § 21.2(a)(2)",
  },
  {
    id: "stay_after_award",
    label: "Automatic stay window (award)",
    anchor: "noticeDate",
    days: 10,
    basis: "Award date",
    ruleText: "A stay of performance applies when the protest is received within 10 calendar days after the date of award.",
    source: "31 U.S.C. § 3553(d)(4)(B)(i)",
  },
  {
    id: "stay_after_debrief",
    label: "Automatic stay window (debriefing)",
    anchor: "debriefDate",
    days: 5,
    basis: "Date the debriefing was held",
    ruleText: "A stay of performance applies when the protest is filed within 5 calendar days after a required debriefing date.",
    source: "31 U.S.C. § 3553(d)(4)(B)(ii)",
  },
  {
    id: "solicitation_challenge",
    label: "Challenge to solicitation terms (before proposals are due)",
    anchor: "proposalsDueDate",
    days: 0,
    basis: "Date initial proposals are due",
    ruleText: "A protest challenging the terms of a solicitation must be filed before the time set for receipt of initial proposals.",
    source: "4 C.F.R. § 21.2(a)(1)",
  },
];

function statusOf(dueDate: string, today: string, applicable: boolean): { status: DeadlineStatus; daysRemaining: number | null } {
  if (!applicable) return { status: "not_applicable", daysRemaining: null };
  const remaining = daysBetween(today, dueDate);
  if (remaining < 0) return { status: "passed", daysRemaining: remaining };
  if (remaining <= 3) return { status: "due_soon", daysRemaining: remaining };
  return { status: "open", daysRemaining: remaining };
}

/**
 * Compute every window that applies to the given dates. Missing anchors are
 * reported as not_applicable rather than guessed, so a wrong date can never be
 * introduced by omission.
 */
export function computeProtestClock(input: ClockInput): ProtestClock {
  if (!parseDate(input.noticeDate)) throw new Error("noticeDate must be YYYY-MM-DD.");
  const today = iso(parseDate(input.now ?? "") ?? new Date());
  const deadlines: ClockDeadline[] = [];

  for (const rule of RULES) {
    const anchorValue = rule.anchor ? input[rule.anchor] : undefined;
    const anchor = typeof anchorValue === "string" ? anchorValue : undefined;
    if (!anchor || !parseDate(anchor)) {
      deadlines.push({
        id: rule.id,
        label: rule.label,
        dueDate: "",
        rawDate: "",
        adjusted: false,
        basis: rule.basis,
        ruleText: rule.ruleText,
        source: rule.source,
        status: "not_applicable",
        daysRemaining: null,
        verifyWithCounsel: true,
        note: `${rule.basis} not provided`,
      });
      continue;
    }
    const rawDate = addDays(anchor, rule.days);
    const dueDate = nextBusinessDay(rawDate);
    const { status, daysRemaining } = statusOf(dueDate, today, true);
    deadlines.push({
      id: rule.id,
      label: rule.label,
      dueDate,
      rawDate,
      adjusted: dueDate !== rawDate,
      basis: `${rule.basis} (${anchor})`,
      ruleText: rule.ruleText,
      source: rule.source,
      status,
      daysRemaining,
      verifyWithCounsel: true,
      note:
        rule.id === "solicitation_challenge"
          ? "Must be filed before the time set for receipt of initial proposals, not on the date itself."
          : dueDate !== rawDate
            ? "Moved to the next business day because the calendar date fell on a weekend or Federal holiday."
            : undefined,
    });
  }

  const filingCandidates = deadlines
    .filter((d) => d.id === "debrief_filing" || d.id === "basis_filing" || d.id === "solicitation_challenge")
    .filter((d) => d.status !== "not_applicable")
    .map((d) => d.dueDate)
    .filter(Boolean)
    .sort();
  const controlling = filingCandidates[0] ?? null;

  return {
    noticeDate: input.noticeDate,
    controllingFilingDeadline: controlling,
    deadlines,
    ruleSources: [...new Set(RULES.map((r) => r.source))],
    disclaimer: CLOCK_DISCLAIMER,
    computedAt: new Date().toISOString(),
  };
}

/** Human line for an alert, used by the panel and by notification jobs. */
export function clockSummary(clock: ProtestClock): string {
  const open = clock.deadlines.filter((d) => d.status === "open" || d.status === "due_soon");
  if (open.length === 0) return "No open protest deadlines on the supplied dates.";
  return open
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .map((d) => `${d.label}: ${d.dueDate}${d.daysRemaining === null ? "" : ` (${d.daysRemaining} day${d.daysRemaining === 1 ? "" : "s"} left)`}`)
    .join(" · ");
}
