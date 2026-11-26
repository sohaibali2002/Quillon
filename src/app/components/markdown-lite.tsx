// Markdown-lite renderer for assistant text. Models reply with `**bold**`,
// `-` lists and links; raw markdown looks broken to users, so this renders
// the small safe subset instead of dumping it. No HTML injection: everything
// is plain React nodes.
import { Fragment, type ReactNode } from "react";

function renderInline(text: string, keyBase: string): ReactNode[] {
  // **bold**, *italic*, `code` — in that priority order.
  const parts: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-i${i++}`;
    if (tok.startsWith("**")) {
      parts.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("`")) {
      parts.push(<code key={key}>{tok.slice(1, -1)}</code>);
    } else {
      parts.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function MarkdownLite({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let code: string[] | null = null;

  const flushList = (key: string) => {
    if (list.length > 0) {
      const items = [...list];
      blocks.push(
        <ul key={key}>
          {items.map((item, i) => (
            <li key={i}>{renderInline(item, `${key}-${i}`)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const key = `b${idx}`;
    if (line.trim().startsWith("```")) {
      if (code === null) {
        flushList(`${key}-ul`);
        code = [];
      } else {
        const finished = code as string[];
        blocks.push(
          <pre key={key} className="md-code">
            {finished.join("\n")}
          </pre>,
        );
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      list.push(bullet[1]);
      continue;
    }
    flushList(`${key}-ul`);
    if (line.trim().length > 0) {
      blocks.push(<p key={key}>{renderInline(line, key)}</p>);
    }
  }
  flushList("tail-ul");
  if (code !== null && code.length > 0) {
    blocks.push(
      <pre key="tail-code" className="md-code">
        {code.join("\n")}
      </pre>,
    );
  }

  return <div className="md">{blocks.length > 0 ? blocks : <p>{text}</p>}</div>;
}

// One-liner fallback for non-React contexts.
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ""))
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\s][^*]*)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

export const Md = Fragment;
