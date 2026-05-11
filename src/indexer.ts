import type Database from "better-sqlite3";
import crypto from "node:crypto";
import { embed } from "./embeddings.js";
import { chunkFile, listIndexableFiles, readFileSnapshot } from "./files.js";
import type { SemanticGrepConfig } from "./config.js";
import { acquireIndexLock, getMeta, resetDb, setMeta, type FileRow, type IndexLock } from "./db.js";

export class IndexerLockedError extends Error {
  constructor() {
    super("another process is already indexing this repo");
    this.name = "IndexerLockedError";
  }
}

export interface IndexStats {
  files: number;
  chunks: number;
  added: number;
  changed: number;
  unchanged: number;
  deleted: number;
  fullRebuild: boolean;
}

function indexFingerprint(config: SemanticGrepConfig): string {
  const payload = {
    schema: 2,
    model: config.embeddings.model,
    dimensions: config.embeddings.dimensions ?? null,
    chunkLines: config.indexing.chunkLines,
    chunkOverlap: config.indexing.chunkOverlap,
    includeExtensions: config.indexing.includeExtensions,
    excludeDirs: config.indexing.excludeDirs,
    maxFileBytes: config.indexing.maxFileBytes,
    maxChunkChars: config.indexing.maxChunkChars,
    skipOversizedChunks: config.indexing.skipOversizedChunks,
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function indexOneFile(db: Database.Database, root: string, file: string, snapshot: NonNullable<ReturnType<typeof readFileSnapshot>>, config: SemanticGrepConfig, signal?: AbortSignal): Promise<number> {
  const chunks = chunkFile(root, file, config, snapshot.hash);

  // Embed all chunks BEFORE touching the DB so partial-state on kill is impossible:
  // a) no write happens until every embedding succeeds; b) all writes commit in one txn.
  const vectors: string[] = new Array(chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    signal?.throwIfAborted();
    const chunk = chunks[i];
    const vector = await embed(`File: ${chunk.file}\nLines: ${chunk.startLine}-${chunk.endLine}\n\n${chunk.text}`, config, signal);
    vectors[i] = JSON.stringify(vector);
  }
  signal?.throwIfAborted();

  const insertChunk = db.prepare("insert into chunks (file, start_line, end_line, text, hash, vector) values (?, ?, ?, ?, ?, ?)");
  const insertFile = db.prepare("insert into files (file, hash, size, mtime_ms, indexed_at) values (?, ?, ?, ?, ?)");
  const deleteChunks = db.prepare("delete from chunks where file = ?");
  const deleteFile = db.prepare("delete from files where file = ?");

  const writeAtomic = db.transaction(() => {
    deleteChunks.run(file);
    deleteFile.run(file);
    insertFile.run(file, snapshot.hash, snapshot.size, snapshot.mtimeMs, new Date().toISOString());
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      insertChunk.run(c.file, c.startLine, c.endLine, c.text, c.hash, vectors[i]);
    }
  });
  writeAtomic();
  return chunks.length;
}

export async function syncIndex(db: Database.Database, root: string, config: SemanticGrepConfig, forceFullRebuild = false, signal?: AbortSignal, onProgress?: (msg: string) => void): Promise<IndexStats> {
  const lock: IndexLock | undefined = acquireIndexLock(root);
  if (!lock) throw new IndexerLockedError();
  try {
    return await syncIndexLocked(db, root, config, forceFullRebuild, signal, onProgress);
  } finally {
    lock.release();
  }
}

async function syncIndexLocked(db: Database.Database, root: string, config: SemanticGrepConfig, forceFullRebuild: boolean, signal?: AbortSignal, onProgress?: (msg: string) => void): Promise<IndexStats> {
  const fingerprint = indexFingerprint(config);
  const priorFingerprint = getMeta(db, "index_fingerprint");
  const fullRebuild = forceFullRebuild || priorFingerprint !== fingerprint;
  if (fullRebuild) resetDb(db);

  const files = listIndexableFiles(root, config);
  const current = new Set(files);
  const knownRows = db.prepare("select file, hash, size, mtime_ms, indexed_at from files").all() as FileRow[];
  const known = new Map(knownRows.map((r) => [r.file, r]));

  let chunks = 0, added = 0, changed = 0, unchanged = 0, deleted = 0;

  const deleteOrphanChunks = db.prepare("delete from chunks where file = ?");
  const deleteOrphanFile = db.prepare("delete from files where file = ?");
  const dropOrphan = db.transaction((file: string) => {
    deleteOrphanChunks.run(file);
    deleteOrphanFile.run(file);
  });
  for (const row of knownRows) {
    if (!current.has(row.file)) {
      dropOrphan(row.file);
      deleted++;
    }
  }

  for (let i = 0; i < files.length; i++) {
    signal?.throwIfAborted();
    const file = files[i];
    const snapshot = readFileSnapshot(root, file);
    if (!snapshot) continue;
    const old = known.get(file);
    const same = old && old.hash === snapshot.hash && old.size === snapshot.size;
    if (!fullRebuild && same) {
      unchanged++;
      continue;
    }

    if (old) changed++; else added++;
    onProgress?.(`[${i + 1}/${files.length}] indexing ${file}`);
    chunks += await indexOneFile(db, root, file, snapshot, config, signal);
  }

  setMeta(db, "index_fingerprint", fingerprint);
  setMeta(db, "indexed_at", new Date().toISOString());
  setMeta(db, "embedding_model", config.embeddings.model);

  return { files: files.length, chunks, added, changed, unchanged, deleted, fullRebuild };
}

export async function buildIndex(db: Database.Database, root: string, config: SemanticGrepConfig, signal?: AbortSignal, onProgress?: (msg: string) => void): Promise<IndexStats> {
  return syncIndex(db, root, config, true, signal, onProgress);
}
