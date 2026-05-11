import Database from "better-sqlite3";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ChunkRow {
  id: number;
  file: string;
  start_line: number;
  end_line: number;
  text: string;
  vector: string;
}

export interface FileRow {
  file: string;
  hash: string;
  size: number;
  mtime_ms: number;
  indexed_at: string;
}

export function dbPathFor(root: string): string {
  return path.join(root, ".pi", "semantic-grep.sqlite");
}

export function lockPathFor(root: string): string {
  return path.join(root, ".pi", "semantic-grep.indexing.lock");
}

export interface IndexLock {
  release(): void;
}

/**
 * Best-effort cross-process advisory lock for the indexer. Uses O_EXCL file
 * creation with a PID + epoch payload; a lock older than `staleMs` whose PID is
 * no longer alive is reclaimed. Returns undefined when another live process
 * holds the lock.
 */
export function acquireIndexLock(root: string, staleMs = 10 * 60_000): IndexLock | undefined {
  const file = lockPathFor(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const payload = `${process.pid}:${Date.now()}`;

  const tryCreate = (): IndexLock | undefined => {
    try {
      const fd = openSync(file, "wx");
      try { writeFileSync(fd, payload); } finally { closeSync(fd); }
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          try { unlinkSync(file); } catch { /* ignore */ }
        },
      };
    } catch {
      return undefined;
    }
  };

  const first = tryCreate();
  if (first) return first;

  // Existing lock — check if it's stale.
  try {
    const raw = readFileSync(file, "utf8").trim();
    const [pidStr, tsStr] = raw.split(":");
    const pid = Number.parseInt(pidStr ?? "", 10);
    const ts = Number.parseInt(tsStr ?? "", 10);
    const ageMs = Number.isFinite(ts) ? Date.now() - ts : Infinity;
    let alive = false;
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    }
    if (!alive || ageMs > staleMs) {
      try { unlinkSync(file); } catch { /* ignore */ }
      return tryCreate();
    }
  } catch { /* unreadable lock — treat as held */ }

  return undefined;
}

export function openDb(root: string): Database.Database {
  mkdirSync(path.join(root, ".pi"), { recursive: true });
  const db = new Database(dbPathFor(root));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    create table if not exists meta (key text primary key, value text not null);
    create table if not exists files (
      file text primary key,
      hash text not null,
      size integer not null,
      mtime_ms real not null,
      indexed_at text not null
    );
    create table if not exists chunks (
      id integer primary key,
      file text not null,
      start_line integer not null,
      end_line integer not null,
      text text not null,
      hash text not null,
      vector text not null,
      foreign key(file) references files(file) on delete cascade
    );
    create index if not exists chunks_file_idx on chunks(file);
  `);
  return db;
}

export function resetDb(db: Database.Database): void {
  db.exec("delete from chunks; delete from files; delete from meta;");
}

export function getMeta(db: Database.Database, key: string): string | undefined {
  return (db.prepare("select value from meta where key = ?").get(key) as { value: string } | undefined)?.value;
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare("insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, value);
}
