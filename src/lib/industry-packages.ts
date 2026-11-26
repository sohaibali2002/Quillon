// Industry packages: curated prompt + tool bundles that turn Quillon into a
// specialist on day one. GovWin/capture, FP&A, investment research, legal,
// healthcare and field service ship in the box; a package can seed unattended
// jobs so the work starts without being asked for.

export type IndustryPackage = {
  id: string;
  name: string;
  category: "government" | "finance" | "research" | "operations";
  tagline: string;
  description: string;
  capabilities: string[];
  seedJobs?: { name: string; prompt: string; schedule: "daily" | "weekly" | "hourly" }[];
};

export const industryPackages: IndustryPackage[] = [
  {
    id: "govwin",
    name: "GovWin & capture",
    category: "government",
    tagline: "Find, qualify and win government opportunities",
    description:
      "Opportunity discovery, SGO/four-quadrant scoring, RFP shredding, compliance matrices and auto-drafted responses, wired to SAM.gov and GovWin APIs when credentials are present.",
    capabilities: [
      "SAM.gov and GovWin opportunity search with NAICS/PSC filters",
      "Bid/no-bid scoring (SGO: strengths, weaknesses, obstacles, incumbency)",
      "RFP shredding into a requirements compliance matrix",
      "Auto-drafted capability statements and past-performance volumes",
      "Expiring-contract and recompete watchlists as unattended jobs",
    ],
    seedJobs: [
      {
        name: "Daily opportunity sweep",
        prompt:
          "Search SAM.gov for opportunities matching our NAICS codes posted in the last 24 hours. For each, give title, agency, due date, set-aside and a one-line bid/no-bid score.",
        schedule: "daily",
      },
      {
        name: "Recompete watchlist",
        prompt: "List contracts we hold that expire in the next 180 days, with the recompete date and incumbent status.",
        schedule: "weekly",
      },
    ],
  },
  {
    id: "auto-rfp",
    name: "Auto RFP response",
    category: "government",
    tagline: "From RFP PDF to compliant first draft in one pass",
    description:
      "Shreds an RFP into section L/M requirements, maps each to past performance from the memory store, drafts responses and flags compliance gaps for human review.",
    capabilities: [
      "Requirement extraction from SOWs, PWSes and RFIs",
      "Compliance matrix with section references and owners",
      "Draft responses grounded in your proposal library (skills + memory)",
      "Gap flags where past performance is missing",
    ],
  },
  {
    id: "fpa",
    name: "FP&A",
    category: "finance",
    tagline: "Budgets, forecasts and variance stories on demand",
    description:
      "Driver-based forecasts, budget-vs-actual variance narratives and board-ready decks generated straight from your workbooks — every number shows its source file.",
    capabilities: [
      "Budget vs actual variance tables with percent and narrative",
      "Driver-based rolling forecasts (headcount, pipeline, churn)",
      "Scenario toggles: base, upside, downside",
      "Board and lender decks generated from the template library",
    ],
    seedJobs: [
      {
        name: "Weekly variance brief",
        prompt: "Summarise this week's budget vs actual variances above 5%, with a likely driver for each and a recommended action.",
        schedule: "weekly",
      },
    ],
  },
  {
    id: "investment-research",
    name: "Investment research",
    category: "finance",
    tagline: "Diligence memos, comps and market maps with citations",
    description:
      "Public-web search plus connector data become sourced research: company tear-downs, comp tables, thesis notes and IC memos where every claim carries a link.",
    capabilities: [
      "Company profiles with sourced financials and funding history",
      "Comparable-company and precedent-transaction tables",
      "Market sizing (TAM/SAM/SOM) with stated assumptions",
      "IC memo generation with numbered sources",
    ],
    seedJobs: [
      {
        name: "Morning market brief",
        prompt: "Summarise overnight news for the sectors we cover, with a one-line relevance note for each item and a source link.",
        schedule: "daily",
      },
    ],
  },
  {
    id: "legal",
    name: "Legal & contracts",
    category: "operations",
    tagline: "First-pass review and clause playbooks",
    description:
      "Contract intake, clause deviation flags against your playbook, obligation calendars and renewal alerts as unattended work.",
    capabilities: [
      "Clause extraction with playbook deviation flags",
      "Obligation and renewal calendar",
      "NDA and MSA first drafts from templates",
    ],
  },
  {
    id: "ops-field",
    name: "Field operations",
    category: "operations",
    tagline: "Schedules, inspection reports and vendor scorecards",
    description:
      "Daily dispatch summaries, inspection report drafting and vendor performance scorecards generated from connector and workbook data.",
    capabilities: [
      "Daily dispatch and route summaries",
      "Inspection report drafts with photo placeholders",
      "Vendor SLA scorecards with trend arrows",
    ],
  },
];

export function getPackage(id: string): IndustryPackage | null {
  return industryPackages.find((p) => p.id === id) ?? null;
}
