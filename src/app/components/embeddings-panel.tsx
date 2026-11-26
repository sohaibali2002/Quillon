"use client";

import { useState } from "react";

type EmbedResult = {
  dimensions: number;
  embedding: number[];
  usage: { tokens: number };
};

type CompareResult = {
  similarity: number;
};

export default function EmbeddingsPanel() {
  const [input, setInput] = useState("The quick brown fox jumps over the lazy dog.");
  const [embed, setEmbed] = useState<EmbedResult | null>(null);
  const [a, setA] = useState("Cats are independent pets.");
  const [b, setB] = useState("Dogs are loyal companions.");
  const [similarity, setSimilarity] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run<T>(body: Record<string, unknown>, onDone: (data: T) => void) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
      onDone(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Embeddings</h2>
      <label htmlFor="embed-input">Text to embed</label>
      <textarea
        id="embed-input"
        rows={2}
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <div className="row">
        <button
          type="button"
          disabled={busy || input.trim().length === 0}
          onClick={() =>
            run({ input }, (d) => setEmbed(d as EmbedResult))
          }
        >
          Embed
        </button>
      </div>

      <label htmlFor="compare-a">Similarity — text A</label>
      <textarea id="compare-a" rows={2} value={a} onChange={(e) => setA(e.target.value)} />
      <label htmlFor="compare-b">Text B</label>
      <textarea id="compare-b" rows={2} value={b} onChange={(e) => setB(e.target.value)} />
      <div className="row">
        <button
          type="button"
          className="secondary"
          disabled={busy || a.trim().length === 0 || b.trim().length === 0}
          onClick={() =>
            run({ compare: [a, b] }, (d) =>
              setSimilarity((d as CompareResult).similarity),
            )
          }
        >
          Compare
        </button>
      </div>

      {error && <p style={{ color: "salmon" }}>Error: {error}</p>}
      {embed && (
        <div className="out">
          {embed.dimensions} dimensions · {embed.usage.tokens} tokens
          {"\n"}first values: [{embed.embedding.slice(0, 6).map((v) => v.toFixed(4)).join(", ")}, …]
        </div>
      )}
      {similarity !== null && (
        <div className="out">
          Cosine similarity: {similarity.toFixed(4)}
        </div>
      )}
    </div>
  );
}
