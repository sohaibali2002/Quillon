"use client";

// MCP desk: configured servers, live tool discovery, manual tool calls.
import { useCallback, useEffect, useState } from "react";
import { Metric, Pill, formatMs, type Tone } from "./ui-bits";

type Server = {
  id: string;
  name: string;
  transport: "http" | "sse" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  enabled: boolean;
};

type DiscoveredTool = {
  server: string;
  serverId: string;
  name: string;
  qualifiedName: string;
  description: string;
};

type Payload = { servers: Server[]; tools?: DiscoveredTool[]; errors?: { server: string; message: string }[] };

export default function McpPanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "sse" | "stdio">("stdio");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("node");
  const [args, setArgs] = useState("scripts/demo-mcp-server.mjs");
  const [adding, setAdding] = useState(false);

  const [callTool, setCallTool] = useState<DiscoveredTool | null>(null);
  const [callArgs, setCallArgs] = useState("{}");
  const [callResult, setCallResult] = useState<string | null>(null);
  const [callMs, setCallMs] = useState<number | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [calling, setCalling] = useState(false);

  const load = useCallback(async (discover = false) => {
    if (discover) setDiscovering(true);
    try {
      const res = await fetch(`/api/mcp${discover ? "?discover=1" : ""}`);
      if (!res.ok) throw new Error();
      const payload = (await res.json()) as Payload;
      setData({ servers: payload.servers ?? [], tools: payload.tools ?? [], errors: payload.errors ?? [] });
      setError(null);
    } catch {
      setError("Could not reach the MCP API.");
    } finally {
      setDiscovering(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (!name.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { action: "add", name, transport };
      if (transport === "stdio") {
        body.command = command;
        body.args = args.split(/\s+/).filter(Boolean);
      } else {
        body.url = url;
      }
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: { message?: string } };
        throw new Error(d.error?.message ?? "Add failed");
      }
      setName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Add failed.");
    } finally {
      setAdding(false);
    }
  }

  async function toggle(s: Server) {
    setError(null);
    try {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "toggle", id: s.id, enabled: !s.enabled }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: { message?: string } };
        throw new Error(d.error?.message ?? "Toggle failed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Toggle failed.");
    } finally {
      await load();
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/mcp?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const d = (await res.json()) as { error?: { message?: string } };
        throw new Error(d.error?.message ?? "Delete failed");
      }
      if (callTool?.serverId === id) setCallTool(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      await load();
    }
  }

  async function runCall() {
    if (!callTool) return;
    setCalling(true);
    setCallError(null);
    setCallResult(null);
    setCallMs(null);
    try {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(callArgs) as Record<string, unknown>;
      } catch {
        throw new Error("Arguments must be valid JSON, for example {\"text\": \"hello\"}.");
      }
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "call", serverId: callTool.serverId, tool: callTool.name, args: parsed }),
      });
      const d = (await res.json()) as { result?: unknown; durationMs?: number; error?: { message?: string } };
      if (!res.ok) throw new Error(d.error?.message ?? "Call failed");
      setCallResult(JSON.stringify(d.result, null, 2));
      setCallMs(d.durationMs ?? null);
    } catch (e) {
      setCallError(e instanceof Error ? e.message : "Call failed.");
    } finally {
      setCalling(false);
    }
  }

  const tools = data?.tools;
  const errors = data?.errors ?? [];

  return (
    <section className="gp-section">
      <header className="gp-section-head">
        <div>
          <h2>MCP servers</h2>
          <p className="gp-fineprint">
            Connect Model Context Protocol servers over streamable HTTP, SSE or
            stdio. Discovered tools join the chat and agent tool loop, namespaced
            as <code>mcp_&lt;server&gt;_&lt;tool&gt;</code>.
          </p>
        </div>
        <div className="gp-metrics">
          <Metric label="Servers" value={data?.servers.length ?? "…"} />
          <Metric label="Tools" value={tools?.length ?? "—"} hint="Run Discover to list live tools" />
        </div>
      </header>

      <div className="gp-form-row">
        <input className="gp-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Server name" aria-label="Server name" maxLength={80} />
        <select className="gp-input gp-select" value={transport} onChange={(e) => setTransport(e.target.value as "http" | "sse" | "stdio")} aria-label="Transport">
          <option value="stdio">stdio</option>
          <option value="http">streamable HTTP</option>
          <option value="sse">SSE</option>
        </select>
        {transport === "stdio" ? (
          <>
            <input className="gp-input" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Command" aria-label="Command" style={{ maxWidth: 140 }} />
            <input className="gp-input" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="Arguments" aria-label="Arguments" />
          </>
        ) : (
          <input className="gp-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" aria-label="Server URL" />
        )}
        <button type="button" className="gp-btn" onClick={() => void add()} disabled={adding || !name.trim()}>
          {adding ? "Adding" : "Add server"}
        </button>
      </div>

      {error && (
        <p role="alert" className="gp-error">
          {error}
        </p>
      )}

      <div className="gp-form-row">
        <button type="button" className="gp-btn" onClick={() => void load(true)} disabled={discovering}>
          {discovering ? "Discovering" : "Discover tools"}
        </button>
        {errors.map((e) => (
          <Pill key={e.server} tone="err" title={e.message}>
            {e.server}: unreachable
          </Pill>
        ))}
      </div>

      {data === null ? (
        <p className="gp-fineprint">Loading servers…</p>
      ) : data.servers.length === 0 ? (
        <p className="gp-fineprint">
          No servers configured. The preinstalled demo runs locally with{" "}
          <code>node scripts/demo-mcp-server.mjs</code> — add it with the form above.
        </p>
      ) : (
        <ul className="gp-list">
          {data.servers.map((s) => (
            <li key={s.id} className="gp-list-row">
              <div className="gp-list-main">
                <span className="gp-list-text">{s.name}</span>
                <span className="gp-fineprint">
                  {s.transport} · {s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url}
                </span>
              </div>
              <Pill tone={(s.enabled ? "ok" : "idle") as Tone}>{s.enabled ? "enabled" : "disabled"}</Pill>
              <button type="button" className="gp-ghost" onClick={() => void toggle(s)}>
                {s.enabled ? "Disable" : "Enable"}
              </button>
              <button type="button" className="gp-ghost" onClick={() => void remove(s.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      {tools && tools.length > 0 && (
        <div className="gp-subsection">
          <h3 className="gp-label">Discovered tools</h3>
          <ul className="gp-list">
            {tools.map((t) => (
              <li key={t.qualifiedName} className="gp-list-row">
                <div className="gp-list-main">
                  <span className="gp-list-text">{t.qualifiedName}</span>
                  <span className="gp-fineprint">{t.description || "no description"}</span>
                </div>
                <Pill tone="run">{t.server}</Pill>
                <button
                  type="button"
                  className="gp-ghost"
                  onClick={() => {
                    setCallTool(t);
                    setCallResult(null);
                    setCallError(null);
                    setCallMs(null);
                    setCallArgs("{}");
                  }}
                >
                  Invoke
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {callTool && (
        <div className="gp-subsection">
          <h3 className="gp-label">
            Invoke <code>{callTool.qualifiedName}</code>
          </h3>
          <div className="gp-form-row">
            <textarea
              className="gp-input gp-textarea"
              value={callArgs}
              onChange={(e) => setCallArgs(e.target.value)}
              rows={3}
              aria-label="Tool arguments as JSON"
            />
            <button type="button" className="gp-btn" onClick={() => void runCall()} disabled={calling}>
              {calling ? "Calling" : "Run"}
            </button>
          </div>
          {callError && (
            <p role="alert" className="gp-error">
              {callError}
            </p>
          )}
          {callResult !== null && (
            <div className="gp-form-row">
              <pre className="gp-pre">{callResult}</pre>
              {callMs !== null && <Pill tone="ok">{formatMs(callMs)}</Pill>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
