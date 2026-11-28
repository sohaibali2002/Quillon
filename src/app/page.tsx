import Link from "next/link";
import SiteHeader from "./components/site-header";
import CopyButton from "./components/copy-button";
import { Brand } from "./components/brand";

const Arrow = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14" />
    <path d="M13 6l6 6-6 6" />
  </svg>
);

const Check = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 12.5l5 5L20 6.5" />
  </svg>
);

const primitives = [
  {
    n: "01",
    title: "Chat & documents",
    copy: "Streaming chat with attachments, typed tool parts and Office file generation — Excel, Word and PowerPoint the model builds and the user downloads.",
    href: "/workspace",
    api: "useChat",
  },
  {
    n: "02",
    title: "Agents",
    copy: "Multi-step tool loops with a step budget, per-step timing and a structured finish. Watch the loop close, step by step.",
    href: "/workspace?panel=agents",
    api: "stopWhen",
  },
  {
    n: "03",
    title: "Workflows",
    copy: "An orchestrator plans, workers fan out in parallel, synthesis closes the loop. Tokens, wall time and finish order per worker.",
    href: "/workspace?panel=workflows",
    api: "streamObject",
  },
  {
    n: "04",
    title: "Structured output",
    copy: "Schemas stream field by field. See which keys landed, which are still pending, and the raw object as it arrives.",
    href: "/workspace?panel=structured",
    api: "streamObject",
  },
  {
    n: "05",
    title: "Code sandbox",
    copy: "Python, JavaScript, TypeScript, Bash, Ruby and PHP in a throwaway directory. Hard timeout, capped output, files captured back.",
    href: "/workspace?panel=sandbox",
    api: "runCode",
  },
  {
    n: "06",
    title: "Brand & document studio",
    copy: "One kit holds your palette, fonts, guidelines and voice. Clone an existing .pptx or .docx for its exact theme, then generate decks, memos and workbooks that come out on-brand every time.",
    href: "/workspace?panel=studio",
    api: "brand kits",
  },
  {
    n: "07",
    title: "Unattended work",
    copy: "Industry packages — GovWin capture, auto-RFP, FP&A, investment research — seed scheduled jobs that run hourly, daily or weekly and keep a full run history. Dispatch to cloud computers over SSH.",
    href: "/workspace?panel=jobs",
    api: "jobs",
  },
  {
    n: "08",
    title: "Enterprise",
    copy: "Entra ID SSO, 41 connectors across the Google, Microsoft, CRM, support, ops and commerce stacks with AES-256-GCM token storage, plus memory, skills, MCP and native local-LLM support (Ollama, LM Studio, vLLM).",
    href: "/workspace?panel=connectors",
    api: "connectors",
  },
];

const streamRows = [
  { t: "0.00s", state: "run", tag: "streaming", k: 'tool-input-start · runCode { language: "py" }' },
  { t: "0.38s", state: "run", tag: "input", k: "tool-input-available · runCode { code: \"print(sum(range(1,11)))\" }" },
  { t: "0.91s", state: "ok", tag: "output", k: "tool-output-available · runCode → 55" },
  { t: "1.12s", state: "", tag: "text", k: "text-delta · The sum of 1 to 10 is 55" },
];

const codeSample = `"use client";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";

const { messages, sendMessage, status } = useChat({
  transport: new DefaultChatTransport({ api: "/api/chat" }),
});

// parts are typed: text, file and tool-<name>
return messages.map((m) =>
  m.parts.map((p) =>
    p.type === "text" ? <p>{p.text}</p> : <ToolPartView part={p} />,
  ),
);`;

export default function Home() {
  return (
    <>
      <SiteHeader />

      <main>
        <section className="hero">
          <div className="wrap">
            <div className="hero-grid">
              <div>
                <span className="eyebrow">Quillon — the enterprise AI platform</span>
                <h1>Every answer shows its work.</h1>
                <p className="lede">
                  Quillon ships the whole stack: streaming chat with typed tool calls,
                  a brand hub and document studio that clone your existing templates,
                  unattended jobs for GovWin capture, auto-RFP, FP&amp;A and investment
                  research, 41 enterprise connectors, Entra ID single sign-on and
                  native local-LLM support. Self-hosted, Apache-2.0, your data never
                  leaves it.
                </p>
                <div className="hero-actions">
                  <Link className="btn" href="/workspace">
                    Ask Quillon <Arrow />
                  </Link>
                  <Link className="btn btn-ghost" href="/workspace?panel=connectors">
                    See connectors
                  </Link>
                </div>
                <div className="hero-note">
                  <span>SSO via Entra ID</span>
                  <span>Template cloning</span>
                  <span>Runs on Ollama locally</span>
                </div>
              </div>

              <div className="stream" aria-label="Example stream inspector">
                <div className="stream-bar">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                  <span style={{ marginLeft: 8 }}>stream inspector</span>
                  <strong>example</strong>
                </div>
                <div className="stream-body">
                  {streamRows.map((r) => (
                    <div className="stream-row" data-state={r.state} key={r.t}>
                      <span className="t">{r.t}</span>
                      <span className="k" title={r.k}>
                        {r.k}
                        {r.tag === "text" && <span className="stream-cursor" aria-hidden="true" />}
                      </span>
                      <span className="stream-tag">{r.tag}</span>
                    </div>
                  ))}
                </div>
                <div className="stream-foot">
                  <span>parts 4</span>
                  <span>tool calls 3</span>
                  <span>transport default</span>
                  <span>state streaming</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="band" aria-label="Platform scale">
          <div className="wrap" style={{ padding: 0 }}>
            <div className="band-inner">
              <div className="band-cell">
                <b>11</b>
                <span>provider integrations</span>
              </div>
              <div className="band-cell">
                <b>6</b>
                <span>industry packages</span>
              </div>
              <div className="band-cell">
                <b>13</b>
                <span>API routes</span>
              </div>
              <div className="band-cell">
                <b>6</b>
                <span>sandbox languages</span>
              </div>
              <div className="band-cell">
                <b>41</b>
                <span>connectors</span>
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="primitives">
          <div className="wrap">
            <div className="section-head">
              <h2>Everything an enterprise deploy ships with.</h2>
              <p>
                Each capability gets its own surface instead of one chat box with extra
                tabs. Same shell, same tokens, same keyboard behaviour — different shape
                for the work.
              </p>
            </div>

            <div className="primitives">
              {primitives.map((p) => (
                <Link className="primitive" href={p.href} key={p.n}>
                  <span className="num">PRIMITIVE {p.n} · {p.api}</span>
                  <h3>{p.title}</h3>
                  <p>{p.copy}</p>
                  <span className="go">
                    Open surface <Arrow />
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="streams">
          <div className="wrap">
            <div className="split">
              <div>
                <span className="eyebrow">Generative UI</span>
                <h2>A stream is a state machine. Quillon draws every transition.</h2>
                <p className="lede">
                  Tool calls move through four documented states. Most interfaces show
                  one. Here each state has a card that says what the model sent, what the
                  runtime is doing and what came back.
                </p>
                <ul>
                  <li>
                    <Check />
                    <span>
                      <b>input-streaming</b> paints partial arguments as they arrive, so a
                      long call never looks frozen.
                    </span>
                  </li>
                  <li>
                    <Check />
                    <span>
                      <b>input-available</b> pins the finished call before any result
                      exists.
                    </span>
                  </li>
                  <li>
                    <Check />
                    <span>
                      <b>output-available</b> renders a typed card per tool, not a raw JSON
                      dump.
                    </span>
                  </li>
                  <li>
                    <Check />
                    <span>
                      <b>output-error</b> attributes the failure to the tool, and keeps the
                      rest of the stream intact.
                    </span>
                  </li>
                </ul>
              </div>

              <div className="visual">
                <div className="visual-head">
                  <span>tool part lifecycle</span>
                  <span>4 states</span>
                </div>
                <div className="state-list">
                  <div className="state-item">
                    <b>input-streaming</b>
                    <span className="chip" data-tone="run">live</span>
                  </div>
                  <div className="state-item">
                    <b>input-available</b>
                    <span className="chip">queued</span>
                  </div>
                  <div className="state-item">
                    <b>output-available</b>
                    <span className="chip" data-tone="ok">settled</span>
                  </div>
                  <div className="state-item">
                    <b>output-error</b>
                    <span className="chip" data-tone="err">failed</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="sandbox">
          <div className="wrap">
            <div className="split">
              <div className="visual" aria-label="Example sandbox run">
                <div className="visual-head">
                  <span>sandbox · python</span>
                  <span>timeout 8s</span>
                </div>
                <div className="term">
                  <div>
                    <span className="dim">$</span> python3 main.py data.csv
                  </div>
                  <div>
                    rows <span className="ac">3</span> · mean <span className="ac">4.8</span>
                  </div>
                  <div className="dim">— exit 0 · 41 ms · 1 file mounted</div>
                  <div>
                    <span className="dim">$</span> <span className="ok">run complete</span>
                  </div>
                </div>
                <div className="state-list" style={{ marginTop: 12 }}>
                  <div className="state-item">
                    <b>stdout / stderr</b> split and capped at 100k chars
                  </div>
                  <div className="state-item">
                    <b>temp dir</b> created per run, removed after
                  </div>
                </div>
              </div>

              <div>
                <span className="eyebrow">Execution</span>
                <h2>Run the code the model wrote.</h2>
                <p className="lede">
                  A throwaway subprocess per run, in the language the task calls for.
                  Files you upload are mounted into the working directory, so a model can
                  legitimately process your data.
                </p>
                <ul>
                  <li>
                    <Check />
                    <span>Python, JavaScript, TypeScript, Bash, Ruby and PHP.</span>
                  </li>
                  <li>
                    <Check />
                    <span>Hard timeout, process group killed, output truncated loudly.</span>
                  </li>
                  <li>
                    <Check />
                    <span>Exit status, duration and run command kept with every result.</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="code">
          <div className="wrap">
            <div className="section-head">
              <h2>The SDK stays the SDK.</h2>
              <p>
                Quillon is a workbench around the AI SDK, not a replacement for it. The
                same hooks, the same transport, the same tool definitions you would write
                in a plain app.
              </p>
            </div>
            <div className="code">
              <div className="code-head">
                <span>app/components/chat.tsx</span>
                <span className="chip">useChat</span>
                <CopyButton value={codeSample} />
              </div>
              <pre tabIndex={0} aria-label="Example useChat source">
                <code>{codeSample}</code>
              </pre>
            </div>
          </div>
        </section>

        <section className="cta">
          <div className="wrap cta-inner">
            <span className="eyebrow">Ready when you are</span>
            <h2>Open a desk and watch it stream.</h2>
            <p>
              Point it at a provider key (AI Gateway, OpenRouter, OpenAI, Anthropic,
              Groq, Cerebras or a local Ollama) and every surface streams live tokens.
            </p>
            <Link className="btn" href="/workspace">
              Open the workbench <Arrow />
            </Link>
          </div>
        </section>
      </main>

      <footer className="site-foot">
        <div className="wrap">
          <div className="foot-grid">
            <div className="foot-col">
              <Brand small="Enterprise AI platform" />
              <span style={{ marginTop: 12, maxWidth: "34ch", color: "var(--faint)" }}>
                Self-hosted, Apache-2.0, built on the AI SDK. SSO, connectors, agents and
                Office generation in one deploy.
              </span>
            </div>
            <div className="foot-col">
              <h4>Platform</h4>
              <Link href="/workspace">Chat &amp; documents</Link>
              <Link href="/workspace?panel=studio">Brand &amp; document studio</Link>
              <Link href="/workspace?panel=jobs">Unattended work</Link>
              <Link href="/workspace?panel=structured">Structured output</Link>
            </div>
            <div className="foot-col">
              <h4>Enterprise</h4>
              <Link href="/workspace?panel=connectors">Connectors</Link>
              <Link href="/workspace?panel=account">SSO &amp; account</Link>
              <Link href="/workspace?panel=setup">Quick setup &amp; cloud computers</Link>
              <Link href="/workspace?panel=brand">Brand hub</Link>
            </div>
            <div className="foot-col">
              <h4>Reference</h4>
              <a href="https://ai-sdk.dev" target="_blank" rel="noreferrer">
                AI SDK docs
              </a>
              <a href="https://ai-sdk.dev/docs/ai-sdk-ui/chatbot" target="_blank" rel="noreferrer">
                useChat guide
              </a>
              <a href="https://ai-sdk.dev/providers/ai-sdk-providers" target="_blank" rel="noreferrer">
                Provider list
              </a>
            </div>
          </div>
          <div className="foot-base">
            <span>© 2026 Quillon</span>
            <span>Apache-2.0 · self-hosted · bring your own model key</span>
          </div>
        </div>
      </footer>
    </>
  );
}
