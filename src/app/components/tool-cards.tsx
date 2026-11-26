// Generative UI for every tool, streamable across all invocation states:
// input-streaming, input-available, output-available, output-error.
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ChatTools } from "@/lib/ai-types";

type ToolPart = ToolUIPart<ChatTools> | DynamicToolUIPart;

type WeatherOutput = {
  location: string;
  temperatureF: number;
  condition: string;
};

type ConversionOutput = { celsius: number };

type TimeOutput = { city: string; timeIso: string };

type CodeOutput = {
  language: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: string | null;
  durationMs: number;
  filesWritten?: string[];
};

type RememberOutput = { saved: boolean; id: string; scope: string };

type RecallOutput = { count: number; memories: { scope: string; content: string }[] };

type DocumentOutput =
  | { ok: true; filename: string; bytes: number; fileDataUrl: string }
  | { ok: false; error: string };

type DocInput = {
  kind?: "xlsx" | "docx" | "pptx";
  filename?: string;
  title?: string;
  rows?: (string | number)[][];
  blocks?: { heading?: string; text?: string; bullets?: string[] }[];
  slides?: { title: string; bullets?: string[] }[];
};

function asText(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((c) => (typeof c === "object" && c !== null && "text" in c ? String((c as { text: string }).text) : JSON.stringify(c)))
      .join("\n");
  }
  return JSON.stringify(output, null, 2);
}

function Frame({
  label,
  state,
  children,
}: {
  label: string;
  state: string;
  children?: React.ReactNode;
}) {
  const streaming = state === "input-streaming" || state === "input-available";
  return (
    <div
      className={`weather-card ${streaming ? "weather-card-live" : ""}`}
      aria-label={`${label} (${state})`}
    >
      <div className="weather-label">
        {label}
        {streaming ? " · running…" : ""}
      </div>
      {children}
    </div>
  );
}

function WeatherBody({ output }: { output: WeatherOutput }) {
  const celsius = Math.round(((output.temperatureF - 32) * 5) / 9);
  return (
    <div className="weather-main">
      <strong>{output.location}</strong>
      <span className="weather-temp">{output.temperatureF}°F</span>
      <span className="weather-sub">
        {output.condition} · {celsius}°C
      </span>
    </div>
  );
}

function ConversionBody({ output }: { output: ConversionOutput }) {
  return (
    <div className="weather-main">
      <span className="weather-temp">{output.celsius}°C</span>
      <span className="weather-sub">converted from Fahrenheit</span>
    </div>
  );
}

function TimeBody({ output }: { output: TimeOutput }) {
  return (
    <div className="weather-main">
      <strong>{output.city}</strong>
      <span className="weather-sub">
        {new Date(output.timeIso).toLocaleString()}
      </span>
    </div>
  );
}

function CodeBody({ output }: { output: CodeOutput }) {
  return (
    <div className="weather-main">
      <span className="weather-label">{output.language}</span>
      {output.stdout && <pre className="code-out">{output.stdout}</pre>}
      {output.stderr && <pre className="code-out">stderr: {output.stderr}</pre>}
      {output.error && <span className="weather-sub">error: {output.error}</span>}
      {output.exitCode !== null && output.exitCode !== 0 && (
        <span className="weather-sub">exit code: {output.exitCode}</span>
      )}
      {output.filesWritten && output.filesWritten.length > 0 && (
        <span className="weather-sub">
          files: {output.filesWritten.join(", ")}
        </span>
      )}
      <span className="weather-sub">{output.durationMs} ms in sandbox</span>
    </div>
  );
}

function MemoryBody({ output }: { output: RememberOutput }) {
  return (
    <div className="weather-main">
      <strong>Saved to memory</strong>
      <span className="weather-sub">
        scope: {output.scope} · the model can recall this in later turns
      </span>
    </div>
  );
}

function RecallBody({ output }: { output: RecallOutput }) {
  return (
    <div className="weather-main">
      <strong>
        {output.count} memory{output.count === 1 ? "" : "ies"} recalled
      </strong>
      <span className="weather-sub">
        {output.memories.map((m) => m.content).join(" · ") || "nothing matched"}
      </span>
    </div>
  );
}

function McpBody({ output }: { output: unknown }) {
  return (
    <div className="weather-main">
      <span className="weather-sub">
        <pre className="mcp-result">{asText(output)}</pre>
      </span>
    </div>
  );
}

function DocumentBody({ input, output }: { input: DocInput; output: DocumentOutput }) {
  const kindLabel = { xlsx: "Excel workbook", docx: "Word document", pptx: "PowerPoint" }[
    input.kind ?? "xlsx"
  ];
  return (
    <div className="weather-main">
      {output.ok ? (
        <>
          <strong>
            {kindLabel} ready — {output.filename}
          </strong>
          <span className="weather-sub">{(output.bytes / 1024).toFixed(1)} kB</span>
          <a
            className="gp-link"
            href={output.fileDataUrl}
            download={output.filename}
            data-testid="doc-download"
          >
            Download {output.filename}
          </a>
        </>
      ) : (
        <span className="weather-sub">Document failed: {output.error}</span>
      )}
    </div>
  );
}

type ConnectorSearchOutput =
  | { ok: true; hits: { title: string; url: string; snippet: string; source: string }[]; error: null; connector: string }
  | { ok: false; hits: []; error: string };

type SearchInput = { connectorId?: string; query?: string };

function ConnectorSearchBody({ input, output }: { input: SearchInput; output: ConnectorSearchOutput }) {
  return (
    <div className="weather-main">
      <strong>
        Searched {input.connectorId ?? "connector"}
        {input.query ? ` for “${input.query}”` : ""}
      </strong>
      {output.ok ? (
        output.hits.length === 0 ? (
          <span className="weather-sub">No results.</span>
        ) : (
          <ul className="cn-hits">
            {output.hits.map((h, i) => (
              <li key={i}>
                <a href={h.url} target="_blank" rel="noreferrer">
                  <b>{h.title}</b>
                  <span>{h.snippet}</span>
                  <small>{h.source}</small>
                </a>
              </li>
            ))}
          </ul>
        )
      ) : (
        <span className="weather-sub">{output.error}</span>
      )}
    </div>
  );
}

function OutputBody({ name, output, input }: { name: string; output: unknown; input?: unknown }) {
  if (name === "weather") return <WeatherBody output={output as WeatherOutput} />;
  if (name === "convertTemperature")
    return <ConversionBody output={output as ConversionOutput} />;
  if (name === "getTime") return <TimeBody output={output as TimeOutput} />;
  if (name === "runCode") return <CodeBody output={output as CodeOutput} />;
  if (name === "remember") return <MemoryBody output={output as RememberOutput} />;
  if (name === "recall") return <RecallBody output={output as RecallOutput} />;
  if (name === "makeDocument")
    return <DocumentBody input={(input ?? {}) as DocInput} output={output as DocumentOutput} />;
  if (name === "searchConnector")
    return (
      <ConnectorSearchBody input={(input ?? {}) as SearchInput} output={output as ConnectorSearchOutput} />
    );
  if (name.startsWith("mcp_")) return <McpBody output={output} />;
  return <pre>{JSON.stringify(output, null, 2)}</pre>;
}

// Renders any tool part in any of its streaming states. Unknown tools get a
// generic JSON card so nothing in the transcript is ever a bare dump.
export function ToolPartView({ part }: { part: ToolPart }) {
  const name =
    "toolName" in part ? part.toolName : part.type.replace(/^tool-/, "");

  if (part.state === "output-error") {
    return (
      <Frame label={name} state={part.state}>
        <span className="weather-sub">error: {part.errorText}</span>
      </Frame>
    );
  }

  if (part.state === "input-streaming" || part.state === "input-available") {
    // While the model is still streaming the input we can't show structured
    // content — just a calm running state, no raw JSON.
    return <Frame label={name} state={part.state} />;
  }

  return (
    <Frame label={name} state={part.state}>
      <OutputBody
        name={name}
        output={part.output}
        input={"state" in part && "input" in part ? (part.input as unknown) : undefined}
      />
    </Frame>
  );
}