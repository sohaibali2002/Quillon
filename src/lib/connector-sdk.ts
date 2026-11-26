// Connector SDK: turns declarative action recipes into native AI SDK tools.
//
// A recipe is data — platform base URL, auth style, and a list of actions
// (method, path template, params). The SDK generates one tool per action, so
// adding enterprise coverage is a few lines of data, not hand-written glue.
// This is the piece that scales to hundreds of tools: every new action in the
// catalog becomes a model-callable tool on the next request.
import { tool, type Tool } from "ai";
import { z } from "zod";
import { readCredential, readToken } from "@/lib/connectors";

export type ParamType = "string" | "number" | "boolean";

export type ActionParam = {
  name: string;
  type: ParamType;
  description: string;
  required?: boolean;
};

export type ConnectorAction = {
  id: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path template with {placeholders} filled from params. */
  path: string;
  /** Params becomes the generated tool's inputSchema. */
  params: ActionParam[];
  /** Param names sent as a JSON body instead of the URL. */
  bodyParams?: string[];
};

/** What a platform receives to authenticate: the token plus the Account field. */
export type ConnectorCredential = { token: string; account: string | null };

export type PlatformRecipe = {
  id: string;
  name: string;
  /** Static, or derived from the credential for account-scoped platforms. */
  baseUrl: string | ((cred: ConnectorCredential) => string);
  /** Headers built from the stored credential, per each platform's official API docs. */
  auth: (cred: ConnectorCredential) => Record<string, string>;
  /** Request body encoding: JSON (default) or form-urlencoded (Stripe). */
  encoding?: "json" | "form";
  actions: ConnectorAction[];
};

function zodFor(p: ActionParam) {
  const base = p.type === "number" ? z.number() : p.type === "boolean" ? z.boolean() : z.string();
  const withDesc = base.describe(p.description);
  return p.required ? withDesc : withDesc.optional();
}

function baseUrlFor(recipe: PlatformRecipe, cred: ConnectorCredential): string {
  return typeof recipe.baseUrl === "function" ? recipe.baseUrl(cred) : recipe.baseUrl;
}

/**
 * Pull a human-readable message out of a platform error body, following each
 * documented error shape: Graph/Stripe {error:{message}}, GitHub/GitLab
 * {message}, Jira {errorMessages}, Freshdesk {description}, Slack {error},
 * generic {detail} / {errors}.
 */
function extractApiError(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.ok === false && typeof d.error === "string") return d.error;
  const err = d.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
  }
  if (typeof d.error === "string") return d.error;
  if (typeof d.message === "string") return d.message;
  if (typeof d.detail === "string") return d.detail;
  if (typeof d.description === "string") return d.description;
  if (Array.isArray(d.errorMessages) && d.errorMessages.length) return String(d.errorMessages[0]);
  if (d.errors) {
    if (typeof d.errors === "string") return d.errors;
    return JSON.stringify(d.errors).slice(0, 300);
  }
  return null;
}

export function buildPlatformTools(recipe: PlatformRecipe): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const action of recipe.actions) {
    const schema: Record<string, any> = {};
    for (const p of action.params) schema[p.name] = zodFor(p);

    tools[`ent_${recipe.id}_${action.id}`] = tool({
      description: `${recipe.name}: ${action.description}`,
      inputSchema: z.object(schema).describe(action.description),
      execute: async (input) => {
        const stored = readCredential(recipe.id);
        if (!stored && !readToken(recipe.id)) {
          return { ok: false, error: `${recipe.name} is not connected. Connect it in the Connectors panel.` };
        }
        const cred: ConnectorCredential = stored ?? { token: readToken(recipe.id) as string, account: null };
        let path = action.path;
        const body: Record<string, unknown> = {};
        const query: Record<string, string> = {};
        for (const p of action.params) {
          const value = (input as Record<string, unknown>)[p.name];
          if (value === undefined) continue;
          if (path.includes(`{${p.name}}`)) {
            path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
          } else if (action.bodyParams?.includes(p.name) || action.method !== "GET") {
            body[p.name] = value;
          } else {
            query[p.name] = String(value);
          }
        }
        if (path.includes("{")) {
          const missing = action.params
            .filter((p) => p.required && path.includes(`{${p.name}}`))
            .map((p) => p.name)
            .join(", ");
          return { ok: false, error: `Missing required parameter(s): ${missing || path.match(/\{([^}]+)\}/)?.[1]}` };
        }
        let url: URL;
        try {
          url = new URL(path, baseUrlFor(recipe, cred));
        } catch {
          return { ok: false, error: `${recipe.name} base URL is misconfigured. Check the connector's Account setting.` };
        }
        for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

        const formEncoded = recipe.encoding === "form";
        let bodyPayload: string | undefined;
        const hasBody = action.method !== "GET" && Object.keys(body).length > 0;
        if (hasBody) {
          if (formEncoded) {
            const search = new URLSearchParams();
            for (const [k, v] of Object.entries(body)) search.set(k, String(v));
            bodyPayload = search.toString();
          } else {
            bodyPayload = JSON.stringify(body);
          }
        }
        try {
          const res = await fetch(url, {
            method: action.method,
            headers: {
              ...recipe.auth(cred),
              accept: "application/json",
              ...(hasBody ? { "content-type": formEncoded ? "application/x-www-form-urlencoded" : "application/json" } : {}),
            },
            body: bodyPayload,
            signal: AbortSignal.timeout(15_000),
          });
          if (res.status === 429) {
            const retryAfter = res.headers.get("retry-after");
            return {
              ok: false,
              error: `${recipe.name} rate limit hit.${retryAfter ? ` Retry after ${retryAfter}s.` : ""}`,
              status: 429,
            };
          }
          const data: unknown = await res.json().catch(() => ({}));
          if (!res.ok) {
            const detail = extractApiError(data);
            return {
              ok: false,
              error: `${recipe.name} returned ${res.status}${detail ? `: ${detail}` : ""}`,
              status: res.status,
            };
          }
          // Some platforms (Slack) report failures inside a 200 response.
          const okFlag = (data as Record<string, unknown>)?.ok;
          if (okFlag === false) {
            return { ok: false, error: `${recipe.name} error: ${extractApiError(data) ?? "request rejected"}` };
          }
          return { ok: true, data };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : "request failed" };
        }
      },
    });
  }
  return tools;
}

/** Tools for every platform that has a stored credential, flattened by tool name. */
export function buildConnectedTools(recipes: PlatformRecipe[]): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  // Only connected platforms get their schemas sent to the model: 200+ action
  // schemas would dominate the prompt when at most a few platforms are wired.
  for (const recipe of recipes) {
    if (!readToken(recipe.id)) continue;
    Object.assign(out, buildPlatformTools(recipe));
  }
  return out;
}

export function countActions(recipes: PlatformRecipe[]): number {
  return recipes.reduce((n, r) => n + r.actions.length, 0);
}
