"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BrandMark } from "@/app/components/brand";
import AgentPanel from "@/app/components/agent-panel";
import WorkflowPanel from "@/app/components/workflow-panel";
import MemoryPanel from "@/app/components/memory-panel";
import SkillsPanel from "@/app/components/skills-panel";
import McpPanel from "@/app/components/mcp-panel";
import StructuredPanel from "@/app/components/structured-panel";
import SandboxPanel from "@/app/components/sandbox-panel";
import EmbeddingsPanel from "@/app/components/embeddings-panel";
import ConnectorsPanel from "@/app/components/connectors-panel";
import AccountPanel from "@/app/components/account-panel";
import BrandPanel from "@/app/components/brand-panel";
import StudioPanel from "@/app/components/studio-panel";
import JobsPanel from "@/app/components/jobs-panel";
import GovernPanel from "@/app/components/govern-panel";
import SetupPanel from "@/app/components/setup-panel";

const icon = (d: string) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const panels = [
  { id: "memory", label: "Memory", hint: "Facts the model keeps", key: "1", icon: icon("M12 4a5 5 0 0 0-5 5c0 3 2 4.5 2 7h6c0-2.5 2-4 2-7a5 5 0 0 0-5-5zM10 20h4"), render: () => <MemoryPanel /> },
  { id: "skills", label: "Skills", hint: "Instruction packs", key: "2", icon: icon("M5 4h11l3 3v13H5zM8 9h8M8 13h8M8 17h5"), render: () => <SkillsPanel /> },
  { id: "mcp", label: "MCP", hint: "External tool servers", key: "3", icon: icon("M12 3v6m0 6v6M3 12h6m6 0h6M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"), render: () => <McpPanel /> },
  { id: "agents", label: "Agent", hint: "Tool loop with steps", key: "4", icon: icon("M12 3v3M5 21v-4a7 7 0 0 1 14 0v4M12 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"), render: () => <AgentPanel /> },
  { id: "workflows", label: "Workflow", hint: "Orchestrator and workers", key: "5", icon: icon("M4 6h6M4 12h10M4 18h7M18 4v16M15 17l3 3 3-3"), render: () => <WorkflowPanel /> },
  { id: "sandbox", label: "Sandbox", hint: "Run code in any language", key: "6", icon: icon("M8 9l-4 3 4 3M16 9l4 3-4 3M13 5l-2 14"), render: () => <SandboxPanel /> },
  { id: "structured", label: "Structured", hint: "Typed objects from a schema", key: "7", icon: icon("M8 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3M9 15l10-10M13 5h6v6"), render: () => <StructuredPanel /> },
  { id: "embeddings", label: "Embeddings", hint: "Similarity search", key: "8", icon: icon("M4 7h6M4 12h10M4 17h7M18 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"), render: () => <EmbeddingsPanel /> },
  { id: "connectors", label: "Connectors", hint: "Enterprise data sources", key: "9", icon: icon("M9 3a3 3 0 0 0-3 3v1H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h1v1a3 3 0 0 0 6 0v-1h1a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-1V6a3 3 0 0 0-3-3zM17 13l4 4m0-4-4 4"), render: () => <ConnectorsPanel /> },
  { id: "brand", label: "Brand", hint: "Kits, guidelines, template cloning", key: "q", icon: icon("M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 8.7l5.4-.8z"), render: () => <BrandPanel /> },
  { id: "studio", label: "Studio", hint: "Branded decks and documents", key: "w", icon: icon("M4 5h16v11H4zM9 20h6M12 16v4M8 9h8M8 12h5"), render: () => <StudioPanel /> },
  { id: "jobs", label: "Unattended", hint: "Scheduled and industry packages", key: "e", icon: icon("M12 8v4l3 3M12 3a9 9 0 1 0 9 9"), render: () => <JobsPanel /> },
  { id: "govern", label: "Govern", hint: "Audit, capabilities, recovery", key: "t", icon: icon("M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z"), render: () => <GovernPanel /> },
  { id: "setup", label: "Setup", hint: "Quick setup and cloud computers", key: "r", icon: icon("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.2-1.6l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2.7-1.6L13.5 2h-3l-.4 2.9a7 7 0 0 0-2.7 1.6l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .5.1 1.1.2 1.6l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2.7 1.6l.4 2.9h3l.4-2.9a7 7 0 0 0 2.7-1.6l2.3 1 2-3.4-2-1.5c.1-.5.2-1.1.2-1.6z"), render: () => <SetupPanel /> },
  { id: "account", label: "Account", hint: "Sign-in and session", key: "0", icon: icon("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0"), render: () => <AccountPanel /> },
] as const;

const navGroups = [
  { id: "work", label: "Build", panelIds: ["agents", "workflows", "sandbox", "structured", "studio"] },
  { id: "knowledge", label: "Knowledge", panelIds: ["memory", "skills", "mcp", "embeddings"] },
  { id: "manage", label: "Manage", panelIds: ["connectors", "brand", "jobs", "govern", "setup", "account"] },
] as const;

function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const active = panels.find((p) => p.id === params.get("panel")) ?? null;
  const drawerRef = useRef<HTMLElement | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(true);
  const [railShown, setRailShown] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState(() => new Set<string>(["work"]));

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 781px)");
    const apply = () => setIsDesktop(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Phone: the rail only exists while the sheet is open, so its buttons can
  // never shadow identically-named controls in the main surface.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!navOpen) {
      setRailShown(false);
      return;
    }
    const id = requestAnimationFrame(() => setRailShown(true));
    return () => cancelAnimationFrame(id);
  }, [navOpen]);

  const open = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (id) next.set("panel", id);
      else next.delete("panel");
      const qs = next.toString();
      router.replace(qs ? `/workspace?${qs}` : "/workspace", { scroll: false });
      if (id) {
        const group = navGroups.find((entry) => entry.panelIds.some((panelId) => panelId === id));
        if (group) setExpandedGroups((current) => new Set(current).add(group.id));
      }
      setNavOpen(false);
    },
    [params, router],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (active) open(null);
        setNavOpen(false);
        return;
      }
      if (e.altKey && !e.metaKey && !e.ctrlKey) {
        const hit = panels.find((p) => e.code === `Digit${p.key}`);
        if (hit) {
          e.preventDefault();
          open(active?.id === hit.id ? null : hit.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, open]);

  useEffect(() => {
    if (active) drawerRef.current?.focus({ preventScroll: true });
  }, [active]);

  return (
    <div className="lx" data-drawer={active ? "open" : "closed"}>
      <a href="#lx-main" className="lx-skip">
        Skip to answer
      </a>

      {(isDesktop || navOpen) && (
        <aside className="lx-rail" data-open={isDesktop || railShown} aria-label="Quillon">
          <Link href="/" className="lx-home" aria-label="Quillon home">
            <BrandMark />
            <span className="lx-brand-copy">
              <span className="lx-wordmark">Quillon</span>
              <span className="lx-product-tag">AI WORKSPACE</span>
            </span>
          </Link>
          <button
            type="button"
            className="lx-new"
            onClick={() => {
              open(null);
              window.dispatchEvent(new Event("quillon:new-thread"));
            }}
          >
            {icon("M12 5v14M5 12h14")}
            <span>New thread</span>
          </button>
          <Link
            href="/workspace"
            className="lx-assistant-link"
            aria-current={pathname === "/workspace" ? "page" : undefined}
          >
            {icon("M4 5.5h16v11H9l-5 3zM8 9h8M8 12.5h5")}
            <span>Assistant</span>
            <span className="lx-assistant-caption">CHAT</span>
          </Link>
          <div className="lx-capabilities-label">Capabilities</div>
          <nav className="lx-nav" aria-label="Workspace tools">
            {navGroups.map((group) => {
              const expanded = expandedGroups.has(group.id);
              return (
                <section className="lx-nav-group" key={group.id}>
                  <button
                    type="button"
                    className="lx-nav-group-toggle"
                    aria-expanded={expanded}
                    aria-controls={`lx-group-${group.id}`}
                    onClick={() => setExpandedGroups((current) => {
                      const next = new Set(current);
                      if (next.has(group.id)) next.delete(group.id);
                      else next.add(group.id);
                      return next;
                    })}
                  >
                    <span>{group.label}</span>
                    <span className="lx-nav-count" aria-hidden="true">{group.panelIds.length}</span>
                    <span className="lx-nav-chevron" aria-hidden="true">{icon("M6 9l6 6 6-6")}</span>
                  </button>
                  <ul className="lx-tools" id={`lx-group-${group.id}`} hidden={!expanded}>
                    {group.panelIds.map((id) => {
                      const panel = panels.find((item) => item.id === id);
                      if (!panel) return null;
                      return (
                        <li key={panel.id}>
                          <button
                            type="button"
                            className="lx-tool"
                            aria-pressed={active?.id === panel.id}
                            aria-controls="lx-drawer"
                            title={`${panel.label} · Alt+${panel.key}`}
                            onClick={() => open(active?.id === panel.id ? null : panel.id)}
                          >
                            {panel.icon}
                            <span>{panel.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </nav>
          <div className="lx-rail-foot">
            <a href="https://ai-sdk.dev" target="_blank" rel="noreferrer">
              AI SDK docs
            </a>
          </div>
        </aside>
      )}

      <div className="lx-top">
        <button
          type="button"
          className="lx-menu"
          aria-label="Open tools"
          aria-expanded={navOpen}
          onClick={() => setNavOpen(true)}
        >
          {icon("M4 7h16M4 12h16M4 17h16")}
        </button>
        <Link href="/" className="lx-home" aria-label="Quillon home">
          <BrandMark />
          <span className="lx-wordmark">Quillon</span>
        </Link>
        <button
          type="button"
          className="lx-menu"
          aria-label="New thread"
          onClick={() => {
            open(null);
            window.dispatchEvent(new Event("quillon:new-thread"));
          }}
        >
          {icon("M12 5v14M5 12h14")}
        </button>
      </div>

      <button
        type="button"
        className="lx-scrim"
        data-open={mounted ? navOpen || Boolean(active) : false}
        aria-label="Close panel"
        tabIndex={-1}
        onClick={() => {
          setNavOpen(false);
          if (active) open(null);
        }}
      />

      <main className="lx-main" id="lx-main">
        {children}
      </main>

      <section
        id="lx-drawer"
        ref={drawerRef}
        className="lx-drawer"
        role="dialog"
        aria-modal="false"
        aria-label={active ? active.label : "Tools"}
        aria-hidden={mounted ? !active : true}
        tabIndex={-1}
      >
        {active && (
          <>
            <header className="lx-drawer-head">
              <div>
                <h2>{active.label}</h2>
                <p>{active.hint}</p>
              </div>
              <button type="button" className="lx-close" onClick={() => open(null)} aria-label={`Close ${active.label}`}>
                {icon("M6 6l12 12M18 6L6 18")}
              </button>
            </header>
            <div className="lx-drawer-body">{active.render()}</div>
          </>
        )}
      </section>
    </div>
  );
}

export default function WorkspaceShell({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<main className="lx-main">{children}</main>}>
      <Shell>{children}</Shell>
    </Suspense>
  );
}
