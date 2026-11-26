"use client";

import { experimental_useObject } from "@ai-sdk/react";
import { z } from "zod";
import { useState } from "react";

const recipeSchema = z.object({
  name: z.string(),
  ingredients: z.array(z.string()),
  steps: z.array(z.string()),
  servings: z.number().int().positive(),
});

export default function StructuredPanel() {
  const [prompt, setPrompt] = useState("A quick weeknight dal recipe");

  const { object, submit, isLoading, error, stop } = experimental_useObject({
    api: "/api/structured",
    schema: recipeSchema,
  });

  return (
    <section className="card" aria-label="Structured output">
      <h2>Structured output (experimental_useObject + Output.object)</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit({ prompt, kind: "object", stream: true });
        }}
      >
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          aria-label="Recipe prompt"
        />
        <div className="row" style={{ marginTop: 8 }}>
          <button type="submit" disabled={isLoading}>
            Generate
          </button>
          {isLoading && (
            <button type="button" className="secondary" onClick={stop}>
              Stop
            </button>
          )}
        </div>
      </form>
      {error && <p style={{ color: "salmon" }}>Error: {error.message}</p>}
      {object && (
        <div className="out">
          <strong>{object.name}</strong> (serves {object.servings})
          <br />
          <br />
          {object.ingredients?.join(" · ")}
          <br />
          <br />
          {object.steps?.map((s, i) => `${i + 1}. ${s}`).join("\n")}
        </div>
      )}
    </section>
  );
}
