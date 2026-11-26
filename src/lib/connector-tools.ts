// searchConnector: let the model query enterprise sources through the
// connector framework. Live search is wired for GitHub and Slack (both have
// plain-HTTPS REST endpoints and token auth); other connectors answer with a
// clear "search not wired yet" instead of pretending.
import { tool } from "ai";
import { z } from "zod";
import { CONNECTOR_CATALOG, connectedIds, readToken } from "@/lib/connectors";

export type ConnectorHit = {
  title: string;
  url: string;
  snippet: string;
  source: string;
};

async function searchGithub(token: string, query: string): Promise<ConnectorHit[]> {
  const res = await fetch(
    `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=5`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`GitHub search failed with ${res.status}`);
  const data = (await res.json()) as {
    items?: { title: string; html_url: string; body?: string; repository_url?: string }[];
  };
  return (data.items ?? []).map((i) => ({
    title: i.title,
    url: i.html_url,
    snippet: (i.body ?? "").slice(0, 160),
    source: "GitHub",
  }));
}

async function searchSlack(token: string, query: string): Promise<ConnectorHit[]> {
  const res = await fetch(
    `https://slack.com/api/search.messages?query=${encodeURIComponent(query)}&count=5`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`Slack search failed with ${res.status}`);
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    messages?: { matches?: { text?: string; permalink?: string; channel?: { name?: string } }[] };
  };
  if (!data.ok) throw new Error(`Slack search error: ${data.error ?? "unknown"}`);
  return (data.messages?.matches ?? []).map((m) => ({
    title: m.channel?.name ? `#${m.channel.name}` : "Slack message",
    url: m.permalink ?? "https://slack.com",
    snippet: (m.text ?? "").slice(0, 160),
    source: "Slack",
  }));
}

export const searchConnectorTool = tool({
  description:
    "Search the enterprise data sources connected in the Connectors panel. " +
    "Pass a connectorId (github, slack, sharepoint, google-drive, jira, notion, " +
    "salesforce) and a search query; returns the top hits with links.",
  inputSchema: z.object({
    connectorId: z.string().describe("Which connector to search, e.g. 'github'"),
    query: z.string().describe("Search text"),
  }),
  execute: async ({ connectorId, query }) => {
    const def = CONNECTOR_CATALOG.find((c) => c.id === connectorId);
    if (!def) {
      return { ok: false as const, hits: [], error: `Unknown connector '${connectorId}'` };
    }
    const token = readToken(connectorId);
    if (!token) {
      return {
        ok: false as const,
        hits: [],
        error: `Not connected. Connect ${def.name} in the Connectors panel first.`,
      };
    }
    try {
      let hits: ConnectorHit[];
      if (connectorId === "github") hits = await searchGithub(token, query);
      else if (connectorId === "slack") hits = await searchSlack(token, query);
      else {
        return {
          ok: false as const,
          hits: [],
          error: `Live search for ${def.name} is not wired yet. Connected, but no search integration.`,
        };
      }
      return { ok: true as const, hits, error: null, connector: def.name };
    } catch (e) {
      return {
        ok: false as const,
        hits: [],
        error: e instanceof Error ? e.message : "Search failed",
      };
    }
  },
});

export function connectedConnectorSummary(): string {
  const ids = connectedIds();
  return ids.length ? ids.join(", ") : "none";
}
