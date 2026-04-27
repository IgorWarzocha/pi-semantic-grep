import type { SemanticGrepConfig } from "./config.js";

interface EmbeddingResponse { data?: Array<{ embedding?: number[] }> }

export async function embed(input: string, config: SemanticGrepConfig, signal?: AbortSignal): Promise<number[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.embeddings.apiKey) headers.Authorization = `Bearer ${config.embeddings.apiKey}`;

  const res = await fetch(config.embeddings.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: config.embeddings.model, input }),
    signal,
  });
  if (!res.ok) throw new Error(`embedding endpoint ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as EmbeddingResponse;
  const vector = json.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) throw new Error("embedding response did not contain data[0].embedding");
  return vector;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, aa = 0, bb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / (Math.sqrt(aa) * Math.sqrt(bb)) : 0;
}
