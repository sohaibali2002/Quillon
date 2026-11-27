"use client";

import { useEffect, useState } from "react";

type ProviderStatus = {
  id: string;
  label: string;
  envVar: string;
  available: boolean;
};

type Config = {
  gateway: { requiredEnvVar: string; set: boolean };
  providers?: ProviderStatus[];
};

export default function ModeBadge() {
  const [live, setLive] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((c: Config) => {
        setLive(Boolean(c.gateway.set) || (c.providers ?? []).some((p) => p.available));
        setProviders(c.providers ?? []);
      })
      .catch(() => setLive(false));
  }, []);

  if (live === null) return null;

  const native = providers.filter((p) => p.available);
  const detail =
    native.length > 0
      ? `native: ${native.map((p) => p.label).join(", ")}`
      : live
        ? "AI Gateway"
        : "no provider key set";

  return (
    <span
      className={`badge ${live ? "badge-live" : "badge-warn"}`}
      role="status"
      title={live ? detail : `${detail} — set AI_GATEWAY_API_KEY or a provider key to go live`}
    >
      <span className="chip-dot" style={{ background: "currentColor" }} aria-hidden="true" />
      {live ? "Live" : "No provider key"}
    </span>
  );
}
