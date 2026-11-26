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
  const [mock, setMock] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((c: Config) => {
        setMock(!c.gateway.set);
        setProviders(c.providers ?? []);
      })
      .catch(() => setMock(true));
  }, []);

  if (mock === null) return null;

  const live = providers.filter((p) => p.available);
  const detail =
    live.length > 0
      ? `native: ${live.map((p) => p.label).join(", ")}`
      : "no native provider keys set";

  return (
    <span
      className={`badge ${mock ? "badge-mock" : "badge-live"}`}
      role="status"
      title={mock ? `${detail} — set AI_GATEWAY_API_KEY or a provider key to go live` : detail}
    >
      <span className="chip-dot" style={{ background: "currentColor" }} aria-hidden="true" />
      {mock ? "Mock mode" : "Live"}
    </span>
  );
}
