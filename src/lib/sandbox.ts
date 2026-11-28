// Multi-language code-execution sandbox.
//
// Each run gets a fresh temp directory; the entry file plus any ingested
// data files are written there and executed as a child process with a hard
// timeout, output caps and no shell. Supported interpreters are detected on
// this machine; arbitrary interpreters can be reached via the `command`
// option (an argv array, never a shell string).
//
// Isolation: runs inside a bubblewrap jail (read-only root, private /tmp,
// dropped capabilities, network denied by default) when the host has it, with
// an unprivileged network namespace as fallback. Set
// QUILLON_SANDBOX_REQUIRE_ISOLATION=1 to refuse execution without a jail.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readdir, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolationRequired, sandboxIsolation } from "@/lib/sandbox-isolation";

export const MAX_TIMEOUT_MS = 15_000;
export const MAX_CODE_CHARS = 100_000;
export const MAX_FILES = 20;
export const MAX_FILE_CHARS = 500_000;
export const MAX_OUTPUT_CHARS = 100_000;
/** Largest single captured file (base64 of a generated document). */
export const MAX_CAPTURED_FILE_CHARS = 4_000_000;
/** Total budget across all captured files. */
export const MAX_CAPTURED_TOTAL_CHARS = 8_000_000;

export type SandboxFile = { name: string; content: string };

export type SandboxInput = {
  language: string;
  code: string;
  files?: SandboxFile[];
  stdin?: string;
  timeoutMs?: number;
  /** Custom interpreter argv, e.g. ["ghc","-e",code]. Overrides `language`. */
  command?: string[];
  /**
   * When true, files the run produced (not the entry file or ingested inputs)
   * are read back and returned base64 in `capturedFiles` — how generated
   * xlsx/docx/pptx/pdf artifacts survive the temp-dir cleanup.
   */
  captureFiles?: boolean;
};

export type SandboxResult = {
  language: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: string | null;
  durationMs: number;
  filesWritten: string[];
  /** Delta the process ran, exactly as spawned (custom `command` echoes here). */
  command: string[];
  /** Timeout actually applied after clamping to [100, MAX_TIMEOUT_MS]. */
  timeoutMs: number;
  timedOut: boolean;
  /** True when stdout or stderr hit MAX_OUTPUT_CHARS and was cut. */
  truncated: boolean;
  entryFile: string | null;
  ingestedFiles: string[];
  stdoutChars: number;
  stderrChars: number;
  /** Which OS-level isolation the run actually had. */
  isolation?: string;
  /** Base64 contents of files the run produced, when captureFiles was set. */
  capturedFiles?: { name: string; base64: string; bytes: number }[];
};

type LangSpec = { ext: string; argv: (main: string) => string[] };

// Interpreters available on this machine (checked at setup, not spawn time).
const LANGUAGES: Record<string, LangSpec> = {
  javascript: { ext: "main.js", argv: (m) => ["node", m] },
  typescript: { ext: "main.ts", argv: (m) => ["node", "--experimental-strip-types", m] },
  python: { ext: "main.py", argv: (m) => ["python3", m] },
  bash: { ext: "main.sh", argv: (m) => ["bash", m] },
  ruby: { ext: "main.rb", argv: (m) => ["ruby", m] },
  php: { ext: "main.php", argv: (m) => ["php", m] },
};

export function listLanguages(): string[] {
  return Object.keys(LANGUAGES);
}

/** Keep file names inside the run directory: strip paths and bad chars. */
function safeName(name: string, i: number): string {
  const base = name.split(/[\\/]/).pop() ?? `file-${i}`;
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return cleaned || `file-${i}`;
}

function cap(s: string): string {
  return s.length > MAX_OUTPUT_CHARS
    ? s.slice(0, MAX_OUTPUT_CHARS) + `\n…[output truncated at ${MAX_OUTPUT_CHARS} chars]`
    : s;
}

// Extensions that are machine-generated artifacts worth returning to the
// client; anything else produced in the temp dir is ignored.
const CAPTURABLE = new Set([
  ".xlsx", ".xlsm", ".csv", ".docx", ".pptx", ".pdf", ".png", ".svg", ".txt", ".json", ".html",
]);

async function readProduced(
  dir: string,
  ingested: string[],
): Promise<{ name: string; base64: string; bytes: number }[]> {
  const ingestedSet = new Set(ingested);
  const out: { name: string; base64: string; bytes: number }[] = [];
  let total = 0;
  for (const entry of await readdir(dir)) {
    if (ingestedSet.has(entry)) continue;
    const ext = entry.slice(entry.lastIndexOf(".")).toLowerCase();
    if (!CAPTURABLE.has(ext)) continue;
    const info = await stat(join(dir, entry)).catch(() => null);
    if (!info?.isFile()) continue;
    const base64 = (await readFile(join(dir, entry))).toString("base64");
    if (base64.length > MAX_CAPTURED_FILE_CHARS || (total += base64.length) > MAX_CAPTURED_TOTAL_CHARS) {
      continue;
    }
    out.push({ name: entry, base64, bytes: info.size });
  }
  return out;
}

export async function runCode(input: SandboxInput): Promise<SandboxResult> {
  const started = Date.now();
  const language = input.language.toLowerCase();
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 10_000, 100), MAX_TIMEOUT_MS);
  const filesWritten: string[] = [];
  const ingestedFiles: string[] = [];

  let argv: string[];
  const dir = await mkdtemp(join(tmpdir(), "sandbox-"));
  const nodeModules = join(process.cwd(), "node_modules");
  const isolation = await sandboxIsolation(dir, { nodeModules });

  if (isolationRequired() && isolation.mode === "none") {
    return {
      language,
      stdout: "",
      stderr: "",
      exitCode: null,
      error: `Code execution is disabled: QUILLON_SANDBOX_REQUIRE_ISOLATION=1 but this host offers no isolation (${isolation.detail}). Install bubblewrap or enable unprivileged user namespaces.`,
      durationMs: Date.now() - started,
      filesWritten,
      command: [],
      timeoutMs,
      timedOut: false,
      truncated: false,
      entryFile: null,
      ingestedFiles,
      stdoutChars: 0,
      stderrChars: 0,
      isolation: isolation.mode,
    };
  }

  try {
    if (Array.isArray(input.command) && input.command.length > 0) {
      argv = [...input.command];
    } else {
      const spec = LANGUAGES[language];
      if (!spec) {
        return {
          language,
          stdout: "",
          stderr: "",
          exitCode: null,
          error: `unsupported language: ${input.language}. Supported: ${listLanguages().join(", ")}, or pass a custom "command" argv array.`,
          durationMs: Date.now() - started,
          filesWritten,
          command: [],
          timeoutMs,
          timedOut: false,
          truncated: false,
          entryFile: null,
          ingestedFiles,
          stdoutChars: 0,
          stderrChars: 0,
        };
      }
      const main = join(dir, spec.ext);
      await writeFile(main, input.code, "utf8");
      filesWritten.push(spec.ext);
      argv = spec.argv(spec.ext);
    }

    const entryFile = filesWritten[0] ?? null;

    // Ingested data files land next to the entry file so code can read them
    // by name (e.g. open("data.csv") in Python).
    const ingested = (input.files ?? []).slice(0, MAX_FILES);
    for (const [i, f] of ingested.entries()) {
      const name = safeName(f.name ?? `file-${i}`, i);
      await writeFile(join(dir, name), f.content ?? "", "utf8");
      filesWritten.push(name);
      ingestedFiles.push(name);
    }

    const finish = (
      exitCode: number | null,
      error: string | null,
      rawStdout: string,
      rawStderr: string,
      timedOut: boolean,
    ): SandboxResult => ({
      language,
      stdout: cap(rawStdout),
      stderr: cap(rawStderr),
      exitCode,
      error,
      durationMs: Date.now() - started,
      filesWritten,
      command: argv,
      timeoutMs,
      timedOut,
      truncated: rawStdout.length > MAX_OUTPUT_CHARS || rawStderr.length > MAX_OUTPUT_CHARS,
      entryFile,
      ingestedFiles,
      stdoutChars: rawStdout.length,
      stderrChars: rawStderr.length,
      isolation: isolation.mode,
    });

    return await new Promise<SandboxResult>((resolve) => {
      const command = isolation.prefix.length ? isolation.prefix[0] : argv[0];
      const args = isolation.prefix.length
        ? [...isolation.prefix.slice(1), ...argv]
        : argv.slice(1);
      const child = spawn(command, args, {
        cwd: dir,
        stdio: ["pipe", "pipe", "pipe"] as const,
        // Own process group: the jail wrapper (bwrap/chroot) is the direct child
        // and the interpreter is its child, so killing only the wrapper leaves
        // `while True: pass` running and the request never settles.
        detached: true,
        // Fresh env on purpose: the child never sees the parent's variables.
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: dir,
          TMPDIR: isolation.mode === "bwrap" ? "/tmp" : dir,
          // Let require("exceljs") and friends resolve the app's node_modules
          // (mounted read-only inside the jail).
          NODE_PATH: isolation.mode === "bwrap" ? "/node_modules" : nodeModules,
          PYTHONPATH: isolation.mode === "bwrap" ? "" : nodeModules,
        } as unknown as NodeJS.ProcessEnv,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const killTree = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            /* already gone */
          }
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree("SIGKILL");
        // Backstop: if a grandchild escaped the group and keeps the pipes open,
        // report the timeout instead of hanging the request forever.
        setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(finish(null, `timed out after ${timeoutMs}ms and was killed`, stdout, stderr, true));
        }, 1500);
      }, timeoutMs);

      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (e) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve(finish(null, `failed to start ${argv[0]}: ${e.message}`, stdout, stderr, false));
      });
      child.on("close", async (exitCode) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        // Read generated artifacts back before the temp dir is removed so
        // xlsx/docx/pptx (binary) files can reach the client.
        const captured = input.captureFiles ? await readProduced(dir, ingestedFiles) : undefined;
        const result = finish(
          exitCode,
          timedOut ? `timed out after ${timeoutMs}ms and was killed` : null,
          stdout,
          stderr,
          timedOut,
        );
        if (captured) result.capturedFiles = captured;
        resolve(result);
      });

      child.stdin.end(input.stdin ?? "");
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
