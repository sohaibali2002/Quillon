import Link from "next/link";
import { Brand } from "./brand";

const links = [
  { href: "#primitives", label: "Primitives" },
  { href: "#streams", label: "Streams" },
  { href: "#sandbox", label: "Sandbox" },
  { href: "#code", label: "Code" },
];

export default function SiteHeader() {
  return (
    <header className="site-head">
      <div className="site-head-inner">
        <Link href="/" aria-label="Quillon home">
          <Brand />
        </Link>

        <nav className="site-nav" aria-label="Primary">
          {links.map((l) => (
            <a key={l.href} className="nav-link" href={l.href}>
              {l.label}
            </a>
          ))}
          <a className="nav-link" href="https://ai-sdk.dev" target="_blank" rel="noreferrer">
            AI SDK docs
          </a>
          <Link className="btn" href="/workspace">
            Open workbench
          </Link>
        </nav>

        <details className="menu">
          <summary className="menu-btn" aria-label="Open menu">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </summary>
          <div className="mobile-nav">
            {links.map((l) => (
              <a key={l.href} className="nav-link" href={l.href}>
                {l.label}
              </a>
            ))}
            <a className="nav-link" href="https://ai-sdk.dev" target="_blank" rel="noreferrer">
              AI SDK docs
            </a>
            <Link className="btn" href="/workspace">
              Open workbench
            </Link>
          </div>
        </details>
      </div>
    </header>
  );
}
