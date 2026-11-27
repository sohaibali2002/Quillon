"use client";

import { useEffect, useState } from "react";

type ProviderStatus = {
  id: string;
  label: string;
  envVar: string;
  available: boolean;
  freeTier?: boolean;
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
        const configuredProviders = c.providers ?? [];
        setProviders(configuredProviders);
        setMock(!c.gateway.set && !configuredProviders.some((provider) => provider.available));
      })
      .catch(() => setMock(true));
  }, []);

  if (mock === null) return null;

  const live = providers.filter((provider) => provider.available);
  const free = live.filter((provider) => provider.freeTier);
  const detail =
    live.length > 0
      ? `Connected: ${live.map((provider) => provider.label).join(", ")}${free.length ? ` · free-tier routes: ${free.map((provider) => provider.label).join(", ")}` : ""}`
      : "No provider credentials detected in this environment";

  return (
    <span
      className={`badge ${mock ? "badge-mock" : "badge-live"}`}
      role="status"
      title={detail}
    >
      <span className="chip-dot" style={{ background: "currentColor" }} aria-hidden="true" />
      {mock ? "Mock mode" : "Live"}
    </span>
  );
}
