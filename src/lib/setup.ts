// Setup: one endpoint that answers "what is configured, what is missing".
// The onboarding panel and the landing page both read it; every check is a
// plain presence probe so nothing sensitive is ever echoed back.

import { listKits, listTemplates } from "@/lib/brand";
import { listJobs } from "@/lib/jobs";
import { listComputers } from "@/lib/cloud-computers";
import { listProviders, type ProviderStatus } from "@/lib/models";

export type SetupCheck = {
  key: string;
  label: string;
  done: boolean;
  how: string;
};

export function setupStatus(): {
  checks: SetupCheck[];
  providers: ProviderStatus[];
  steps: { title: string; body: string; href: string; done: boolean }[];
  quickstart: { ollama: string; env: string; docker: string };
} {
  const has = (...names: string[]) => names.some((n) => Boolean(process.env[n]));
  const localLlm = has("OLLAMA_BASE_URL") || has("LOCAL_LLM_BASE_URL");
  const providers = listProviders();
  const freeProviders = providers.filter((provider) => provider.freeTier);
  const checks: SetupCheck[] = [
    { key: "model", label: "A model is configured", done: true, how: "Works in mock mode out of the box; add any provider key for live models." },
    { key: "live-model", label: "A live model provider is available", done: has("AI_GATEWAY_API_KEY") || providers.some((provider) => provider.available) || localLlm, how: "Use Vercel AI Gateway, a configured provider key, or a local Ollama endpoint." },
    { key: "brand", label: "A brand kit exists", done: listKits().length > 0, how: "Create a kit in the Brand hub — colors, fonts, guidelines and assets." },
    { key: "templates", label: "A template was cloned or generated", done: listTemplates().length > 0, how: "Upload a .pptx/.docx in the Studio to clone its exact theme, or use a standard template." },
    { key: "jobs", label: "An unattended job is scheduled", done: listJobs().some((j) => j.enabled && j.schedule !== "manual"), how: "Pick an industry package and enable one of its seeded jobs." },
    { key: "cloud", label: "A cloud computer is registered", done: listComputers().length > 0, how: "Add an SSH host (Vast, RunPod, Lambda, your own box) under Computers." },
    { key: "sso", label: "SSO is enabled (optional)", done: has("AUTH_ISSUER", "AUTH_CLIENT_ID"), how: "Set AUTH_ISSUER, AUTH_CLIENT_ID and AUTH_CLIENT_SECRET for Entra ID / any OIDC." },
  ];
  const steps = [
    { title: "Choose a model provider", body: "Use the free-tier Cerebras, Groq or OpenRouter routes, Vercel AI Gateway, or a local Ollama model.", href: "/workspace", done: checks[1].done },
    { title: "Create your brand kit", body: "Colors, fonts, guidelines, voice and logos become the source of truth for every document.", href: "/workspace?panel=brand", done: checks[2].done },
    { title: "Clone a template", body: "Upload an existing .pptx or .docx and Quillon reads its exact theme for reuse.", href: "/workspace?panel=studio", done: checks[3].done },
    { title: "Turn on unattended work", body: "Enable a seeded job from an industry package and it runs on schedule, no one watching.", href: "/workspace?panel=jobs", done: checks[4].done },
  ];
  return {
    checks,
    providers: freeProviders,
    steps,
    quickstart: {
      ollama: "ollama serve && ollama pull llama3.1   # then set OLLAMA_BASE_URL=http://127.0.0.1:11434",
      env: "CEREBRAS_API_KEY=...  # or GROQ_API_KEY / OPENROUTER_API_KEY / AI_GATEWAY_API_KEY",
      docker: "docker compose up   # app + postgres + redis, then open http://localhost:3000",
    },
  };
}
