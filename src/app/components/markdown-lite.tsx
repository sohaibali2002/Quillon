// Markdown-lite renderer keeps model output readable without permitting raw HTML.
import { Fragment, type ReactNode } from "react";

type ListState = { ordered: boolean; items: string[] };

function safeMarkdownHref(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? value : undefined;
  } catch {
    return undefined;
  }
}

function renderInline(text: string, keyBase: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(\[[^\]]+\]\([^\s)]+\)|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = re.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyBase}-i${index++}`;
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);

    if (link) {
      const href = safeMarkdownHref(link[2]);
      parts.push(href
        ? <a key={key} href={href} target="_blank" rel="noopener noreferrer">{link[1]}</a>
        : link[1]);
    } else if (token.startsWith("**")) {
      parts.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      parts.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }

  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function codeBlock(language: string, lines: string[], key: string) {
  return (
    <figure key={key} className="md-code-block">
      <figcaption>{language || "Code snippet"}</figcaption>
      <pre className="md-code"><code>{lines.join("\n")}</code></pre>
    </figure>
  );
}

export function MarkdownLite({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let list: ListState | null = null;
  let quote: string[] = [];
  let code: string[] | null = null;
  let codeLanguage = "";

  const flushList = (key: string) => {
    if (!list) return;
    const List = list.ordered ? "ol" : "ul";
    blocks.push(
      <List key={key}>
        {list.items.map((item, itemIndex) => (
          <li key={itemIndex}>{renderInline(item, `${key}-${itemIndex}`)}</li>
        ))}
      </List>,
    );
    list = null;
  };

  const flushQuote = (key: string) => {
    if (quote.length === 0) return;
    blocks.push(
      <blockquote key={key}>
        <p>{renderInline(quote.join(" "), key)}</p>
      </blockquote>,
    );
    quote = [];
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const key = `b${lineIndex}`;
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (code === null) {
        flushList(`${key}-list`);
        flushQuote(`${key}-quote`);
        code = [];
        codeLanguage = trimmed.slice(3).trim().split(/\s+/, 1)[0] ?? "";
      } else {
        blocks.push(codeBlock(codeLanguage, code, key));
        code = null;
        codeLanguage = "";
      }
      continue;
    }

    if (code !== null) {
      code.push(line);
      continue;
    }

    if (trimmed.length === 0) {
      flushList(`${key}-list`);
      flushQuote(`${key}-quote`);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,4})\s+(.+)$/);
    if (heading) {
      flushList(`${key}-list`);
      flushQuote(`${key}-quote`);
      const Heading = `h${heading[1].length}` as "h1" | "h2" | "h3" | "h4";
      blocks.push(<Heading key={key}>{renderInline(heading[2], key)}</Heading>);
      continue;
    }

    if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
      flushList(`${key}-list`);
      flushQuote(`${key}-quote`);
      blocks.push(<hr key={key} />);
      continue;
    }

    const unordered = line.match(/^\s*[-*•]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (unordered || ordered) {
      flushQuote(`${key}-quote`);
      const orderedList = Boolean(ordered);
      if (list && list.ordered !== orderedList) flushList(`${key}-list`);
      if (!list) list = { ordered: orderedList, items: [] };
      list.items.push((ordered ?? unordered)![1]);
      continue;
    }

    const quoted = line.match(/^\s*>\s?(.*)$/);
    if (quoted) {
      flushList(`${key}-list`);
      quote.push(quoted[1]);
      continue;
    }

    flushList(`${key}-list`);
    flushQuote(`${key}-quote`);
    blocks.push(<p key={key}>{renderInline(line, key)}</p>);
  }

  flushList("tail-list");
  flushQuote("tail-quote");
  if (code !== null) blocks.push(codeBlock(codeLanguage, code, "tail-code"));

  return <div className="md">{blocks.length > 0 ? blocks : <p>{text}</p>}</div>;
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```\w*\n?/g, ""))
    .replace(/^\s{0,3}#{1,4}\s+/gm, "")
    .replace(/^\s*[-*•]\s+|^\s*\d+[.)]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\s][^*]*)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

export const Md = Fragment;
