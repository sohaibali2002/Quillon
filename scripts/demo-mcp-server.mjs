// Demo MCP server over stdio: newline-delimited JSON-RPC per the MCP spec,
// implemented with no dependencies. Used by the MCP desk and smoke tests to
// prove the client transport without any network access.
// Run: node scripts/demo-mcp-server.mjs
import readline from "node:readline";

const tools = [
  {
    name: "echo",
    description: "Echo the provided text back to the caller.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo" } },
      required: ["text"],
    },
  },
  {
    name: "word_count",
    description: "Count words, characters and sentences in the provided text.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to analyse" } },
      required: ["text"],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function toolResult(text) {
  return { content: [{ type: "text", text }] };
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "quillon-demo", version: "1.0.0" },
      },
    });
    return;
  }
  if (method?.startsWith("notifications/")) return; // no response for notifications
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === "echo") {
      send({ jsonrpc: "2.0", id, result: toolResult(`echo: ${args.text ?? ""}`) });
    } else if (name === "word_count") {
      const text = String(args.text ?? "");
      send({
        jsonrpc: "2.0",
        id,
        result: toolResult(
          JSON.stringify({
            words: text.split(/\s+/).filter(Boolean).length,
            characters: text.length,
            sentences: text.split(/[.!?]+/).filter((s) => s.trim()).length,
          }),
        ),
      });
    } else {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${name}` },
      });
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
