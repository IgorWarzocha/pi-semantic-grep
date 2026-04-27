import type Database from "better-sqlite3";
import { embed, cosine } from "./embeddings.js";
import type { SemanticGrepConfig } from "./config.js";
import type { ChunkRow } from "./db.js";

export interface SearchMatch {
  file: string;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
}

export async function searchDb(db: Database.Database, query: string, topK: number, config: SemanticGrepConfig, signal?: AbortSignal): Promise<SearchMatch[]> {
  const q = await embed(query, config, signal);
  const rows = db.prepare("select id, file, start_line, end_line, text, vector from chunks").all() as ChunkRow[];
  const scored = rows.map((r) => ({
    file: r.file,
    startLine: r.start_line,
    endLine: r.end_line,
    text: r.text,
    score: cosine(q, JSON.parse(r.vector) as number[]),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export function formatMatches(matches: SearchMatch[]): string {
  if (matches.length === 0) return "No semantic grep matches. Try running /semantic-grep-index first.";
  return matches.map((m, i) => {
    return `## ${i + 1}. ${m.file}:${m.startLine}-${m.endLine} score=${m.score.toFixed(4)}\n\n\`\`\`${m.file}\n${m.text}\n\`\`\``;
  }).join("\n\n");
}
