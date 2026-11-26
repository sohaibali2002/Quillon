// Connector framework: an enterprise registry of data sources the assistant
// may use. Each connector declares its OAuth settings and the tools it adds.
// Tokens are stored encrypted at rest (AES-256-GCM) keyed by CONNECTORS_SECRET.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getDb } from "./db";

export type ConnectorCategory = "files" | "tickets" | "chat" | "crm" | "knowledge" | "custom";

export type ConnectorDef = {
  id: string;
  name: string;
  category: ConnectorCategory;
  description: string;
  auth: "oauth2" | "pat" | "none";
  scopes: string[];
  docs: string;
};

export const CONNECTOR_CATALOG: ConnectorDef[] = [
  {
    id: "sharepoint",
    name: "Microsoft SharePoint / OneDrive",
    category: "files",
    description: "Search and read documents from Microsoft 365 sites and drives via Microsoft Graph.",
    auth: "oauth2",
    scopes: ["Files.Read.All", "Sites.Read.All", "User.Read"],
    docs: "https://learn.microsoft.com/en-us/sharepoint/dev/",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    category: "files",
    description: "Search and read files from shared and personal Google drives.",
    auth: "oauth2",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    docs: "https://developers.google.com/drive",
  },
  {
    id: "slack",
    name: "Slack",
    category: "chat",
    description: "Search workspace history and post summaries back to channels.",
    auth: "oauth2",
    scopes: ["channels:history", "groups:history", "search:read", "chat:write"],
    docs: "https://api.slack.com/docs/oauth",
  },
  {
    id: "jira",
    name: "Jira",
    category: "tickets",
    description: "Search issues and read ticket details from a Jira site.",
    auth: "oauth2",
    scopes: ["read:jira-work"],
    docs: "https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/",
  },
  {
    id: "github",
    name: "GitHub",
    category: "knowledge",
    description: "Search repositories, issues and pull requests with a fine-grained token.",
    auth: "pat",
    scopes: ["repo:read"],
    docs: "https://docs.github.com/rest",
  },
  {
    id: "notion",
    name: "Notion",
    category: "knowledge",
    description: "Search and read pages from connected Notion workspaces.",
    auth: "pat",
    scopes: [],
    docs: "https://developers.notion.com/docs/getting-started",
  },
  {
    id: "salesforce",
    name: "Salesforce",
    category: "crm",
    description: "Query accounts, contacts and opportunities with SOQL.",
    auth: "oauth2",
    scopes: ["api"],
    docs: "https://developer.salesforce.com/docs/",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    category: "crm",
    description: "Search contacts and companies, create contacts and read tickets.",
    auth: "pat",
    scopes: ["crm.objects.contacts.read", "crm.objects.companies.read"],
    docs: "https://developers.hubspot.com/docs/api/overview",
  },
  { id: "confluence", name: "Confluence", category: "knowledge", description: "Search, read and create wiki pages in a Confluence site.", auth: "oauth2", scopes: ["read:content", "write:content"], docs: "https://developer.atlassian.com/cloud/confluence/rest/" },
  { id: "pipedrive", name: "Pipedrive", category: "crm", description: "Manage deals, contacts and activities in a sales pipeline.", auth: "oauth2", scopes: ["deals:read", "deals:write"], docs: "https://developers.pipedrive.com/docs/api/v1" },
  { id: "gmail", name: "Gmail", category: "chat", description: "Read, search and send email over the Gmail API.", auth: "oauth2", scopes: ["https://mail.google.com/"], docs: "https://developers.google.com/gmail/api" },
  { id: "google-calendar", name: "Google Calendar", category: "custom", description: "Create, read and update calendar events.", auth: "oauth2", scopes: ["https://www.googleapis.com/auth/calendar"], docs: "https://developers.google.com/calendar" },
  { id: "google-sheets", name: "Google Sheets", category: "files", description: "Read, append and write spreadsheet rows.", auth: "oauth2", scopes: ["https://www.googleapis.com/auth/spreadsheets"], docs: "https://developers.google.com/sheets" },
  { id: "google-docs", name: "Google Docs", category: "files", description: "Read and create Google documents.", auth: "oauth2", scopes: ["https://www.googleapis.com/auth/documents"], docs: "https://developers.google.com/docs/api" },
  { id: "google-tasks", name: "Google Tasks", category: "custom", description: "Manage task lists and mark tasks complete.", auth: "oauth2", scopes: ["https://www.googleapis.com/auth/tasks"], docs: "https://developers.google.com/tasks" },
  { id: "microsoft-teams", name: "Microsoft Teams", category: "chat", description: "Read and post messages in Teams channels.", auth: "oauth2", scopes: ["Team.ReadBasic.All", "ChannelMessage.Send"], docs: "https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview" },
  { id: "outlook-mail", name: "Outlook Mail", category: "chat", description: "Read, search and send Outlook email via Microsoft Graph.", auth: "oauth2", scopes: ["Mail.Read", "Mail.Send"], docs: "https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview" },
  { id: "outlook-calendar", name: "Outlook Calendar", category: "custom", description: "Create, read and update Outlook calendar events.", auth: "oauth2", scopes: ["Calendars.ReadWrite"], docs: "https://learn.microsoft.com/en-us/graph/api/resources/calendar" },
  { id: "excel-online", name: "Microsoft Excel Online", category: "files", description: "Read ranges and append rows to Excel workbooks.", auth: "oauth2", scopes: ["Files.ReadWrite.All"], docs: "https://learn.microsoft.com/en-us/graph/api/resources/excel" },
  { id: "zendesk", name: "Zendesk", category: "tickets", description: "Search, create and update support tickets.", auth: "oauth2", scopes: ["read", "write"], docs: "https://developer.zendesk.com/api-reference" },
  { id: "freshdesk", name: "Freshdesk", category: "tickets", description: "List, create and update customer support tickets.", auth: "oauth2", scopes: [], docs: "https://developers.freshdesk.com/api/" },
  { id: "intercom", name: "Intercom", category: "tickets", description: "Read conversations and contacts, reply as an admin.", auth: "oauth2", scopes: [], docs: "https://developers.intercom.com/docs" },
  { id: "servicenow", name: "ServiceNow", category: "tickets", description: "List, create and update incidents and table records.", auth: "oauth2", scopes: ["useraccount"], docs: "https://developer.servicenow.com/dev.do#!/reference/api" },
  { id: "stripe", name: "Stripe", category: "custom", description: "Read balances, customers and invoices; create payment links.", auth: "pat", scopes: [], docs: "https://docs.stripe.com/api" },
  { id: "shopify", name: "Shopify", category: "custom", description: "Manage orders, products and customers in a store.", auth: "pat", scopes: ["read_orders", "read_products"], docs: "https://shopify.dev/docs/api/admin-rest" },
  { id: "mailchimp", name: "Mailchimp", category: "custom", description: "Manage audiences, members and email campaigns.", auth: "oauth2", scopes: [], docs: "https://mailchimp.com/developer/marketing/api/" },
  { id: "twilio", name: "Twilio", category: "chat", description: "Send SMS and list message and call history.", auth: "pat", scopes: [], docs: "https://www.twilio.com/docs/usage/api" },
  { id: "zoom", name: "Zoom", category: "custom", description: "Schedule meetings and list recordings.", auth: "oauth2", scopes: ["meeting:read", "meeting:write"], docs: "https://developers.zoom.us/docs/api" },
  { id: "asana", name: "Asana", category: "tickets", description: "Manage tasks and projects in workspaces.", auth: "oauth2", scopes: [], docs: "https://developers.asana.com/reference" },
  { id: "monday", name: "Monday.com", category: "tickets", description: "Query boards and create items via GraphQL.", auth: "oauth2", scopes: [], docs: "https://developer.monday.com/api-reference/docs" },
  { id: "airtable", name: "Airtable", category: "knowledge", description: "Read, create and update records across bases.", auth: "pat", scopes: [], docs: "https://airtable.com/developers/web/api/introduction" },
  { id: "docusign", name: "DocuSign", category: "custom", description: "Track envelopes and signature status.", auth: "oauth2", scopes: ["signature"], docs: "https://developers.docusign.com/docs/esign-rest-api/" },
  { id: "datadog", name: "Datadog", category: "custom", description: "Read monitors, events and hosts; mute monitors.", auth: "pat", scopes: [], docs: "https://docs.datadoghq.com/api/latest/" },
  { id: "pagerduty", name: "PagerDuty", category: "tickets", description: "List and acknowledge incidents, read on-call.", auth: "oauth2", scopes: [], docs: "https://developer.pagerduty.com/api-reference/" },
  { id: "sentry", name: "Sentry", category: "custom", description: "Read projects, issues and releases; resolve issues.", auth: "pat", scopes: [], docs: "https://docs.sentry.io/api/" },
  { id: "linear", name: "Linear", category: "tickets", description: "List and create issues via GraphQL.", auth: "oauth2", scopes: [], docs: "https://developers.linear.app/docs" },
  { id: "gitlab", name: "GitLab", category: "knowledge", description: "Manage projects, issues and merge requests.", auth: "pat", scopes: [], docs: "https://docs.gitlab.com/ee/api/" },
  { id: "dropbox", name: "Dropbox", category: "files", description: "List, search and inspect Dropbox files.", auth: "oauth2", scopes: ["files.metadata.read"], docs: "https://www.dropbox.com/developers/documentation" },
  { id: "box", name: "Box", category: "files", description: "Search and read files across an enterprise.", auth: "oauth2", scopes: [], docs: "https://developer.box.com/reference/" },
  { id: "calendly", name: "Calendly", category: "custom", description: "Read event types and scheduled meetings.", auth: "oauth2", scopes: [], docs: "https://developer.calendly.com/api-docs" },
  { id: "xero", name: "Xero", category: "custom", description: "Read invoices, contacts and the chart of accounts.", auth: "oauth2", scopes: ["accounting.transactions", "accounting.contacts"], docs: "https://learn.accounting.xero.com/accounting-api" },
];

export function catalogFor(clientId?: string) {
  return CONNECTOR_CATALOG.map((c) => ({
    ...c,
    connected: false,
    clientIdSet: Boolean(clientId),
  }));
}

const KEY = (secret: string) => createHash("sha256").update(secret).digest();

export function encryptToken(secret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY(secret), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    enc.toString("base64url"),
  ].join(".");
}

export function decryptToken(secret: string, stored: string): string {
  const [ivPart, tagPart, dataPart] = stored.split(".");
  if (!ivPart || !tagPart || !dataPart) throw new Error("Malformed token blob");
  const decipher = createDecipheriv("aes-256-gcm", KEY(secret), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
}

export function connectorsSecret(): string {
  return process.env.CONNECTORS_SECRET?.trim() || process.env.AUTH_SECRET?.trim() || "quillon-dev-key";
}

export function ensureConnectorTables() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS connector_tokens (
      connector_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('oauth2', 'pat')),
      token_encrypted TEXT NOT NULL,
      account TEXT,
      scopes TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}

export function saveToken(connectorId: string, kind: "oauth2" | "pat", token: string, account: string | null, scopes: string[]) {
  ensureConnectorTables();
  getDb()
    .prepare(
      `INSERT INTO connector_tokens (connector_id, kind, token_encrypted, account, scopes, updated_at)
       VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(connector_id) DO UPDATE SET
         kind=excluded.kind, token_encrypted=excluded.token_encrypted,
         account=excluded.account, scopes=excluded.scopes,
         updated_at=excluded.updated_at`,
    )
    .run(connectorId, kind, encryptToken(connectorsSecret(), token), account, JSON.stringify(scopes));
}

export function readToken(connectorId: string): string | null {
  ensureConnectorTables();
  const row = getDb().prepare("SELECT token_encrypted FROM connector_tokens WHERE connector_id = ?").get(connectorId) as
    | { token_encrypted: string }
    | undefined;
  if (!row) return null;
  try {
    return decryptToken(connectorsSecret(), row.token_encrypted);
  } catch {
    return null;
  }
}

/** Token plus the connector's Account field (subdomain, datacenter, app key, ...). */
export function readCredential(connectorId: string): { token: string; account: string | null } | null {
  ensureConnectorTables();
  const row = getDb()
    .prepare("SELECT token_encrypted, account FROM connector_tokens WHERE connector_id = ?")
    .get(connectorId) as { token_encrypted: string; account: string | null } | undefined;
  if (!row) return null;
  try {
    return { token: decryptToken(connectorsSecret(), row.token_encrypted), account: row.account ?? null };
  } catch {
    return null;
  }
}

export function deleteToken(connectorId: string) {
  ensureConnectorTables();
  getDb().prepare("DELETE FROM connector_tokens WHERE connector_id = ?").run(connectorId);
}

export function connectedIds(): string[] {
  ensureConnectorTables();
  return (
    getDb()
      .prepare("SELECT connector_id FROM connector_tokens")
      .all()
      .map((r) => String((r as { connector_id: string }).connector_id))
  );
}
