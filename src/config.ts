import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface SemanticGrepConfig {
  embeddings: {
    url: string;
    model: string;
    apiKey?: string;
    dimensions?: number;
  };
  indexing: {
    chunkLines: number;
    chunkOverlap: number;
    maxFileBytes: number;
    maxChunkChars: number;
    skipOversizedChunks: boolean;
    includeExtensions: string[];
    excludeDirs: string[];
  };
  search: {
    defaultTopK: number;
    maxTopK: number;
  };
  autoIndex: {
    enabled: boolean;
    mode: "incremental" | "always" | "missing";
  };
  safety: {
    requireProjectMarker: boolean;
    projectMarkers: string[];
    denyRootBasenames: string[];
    denyRootPaths: string[];
  };
}

export const CONFIG_PATH = path.join(homedir(), ".pi", "agent", "semantic-grep.json");

export const DEFAULT_CONFIG: SemanticGrepConfig = {
  embeddings: {
    url: "http://127.0.0.1:1234/v1/embeddings",
    model: "text-embedding-embeddinggemma-300m-qat",
  },
  indexing: {
    chunkLines: 80,
    chunkOverlap: 20,
    maxFileBytes: 512_000,
    maxChunkChars: 12_000,
    skipOversizedChunks: false,
    includeExtensions: [
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
      ".py", ".lua", ".rs", ".go", ".java", ".cs", ".cpp", ".c", ".h", ".hpp",
      ".md", ".json", ".yaml", ".yml", ".toml", ".css", ".scss", ".html", ".svelte", ".vue"
    ],
    excludeDirs: [".git", ".pi", "node_modules", "dist", "build", "target", ".venv", "venv", "vendor", ".next", ".cache"],
  },
  search: {
    defaultTopK: 8,
    maxTopK: 30,
  },
  autoIndex: {
    enabled: true,
    mode: "incremental",
  },
  safety: {
    requireProjectMarker: true,
    projectMarkers: [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "deno.json", "bun.lock", "pnpm-lock.yaml", "yarn.lock"],
    denyRootBasenames: [
      "Desktop", "Documents", "Downloads", "Pictures", "Music", "Movies", "Videos", "Public", "Templates",
      "Applications", "Library", "System", "Volumes", "Users",
      "Program Files", "Program Files (x86)", "ProgramData", "Windows", "PerfLogs",
      "AppData", "OneDrive", "Dropbox", "Google Drive", "iCloud Drive"
    ],
    denyRootPaths: ["~", "/", "C:\\", "C:/"],
  },
};

function deepMerge<T>(base: T, override: Partial<T>): T {
  const out: any = Array.isArray(base) ? [...base] : { ...(base as any) };
  for (const [key, value] of Object.entries(override as any)) {
    if (value && typeof value === "object" && !Array.isArray(value) && key in out) {
      out[key] = deepMerge(out[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export function ensureConfig(): SemanticGrepConfig {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, "\t") + "\n");
    return DEFAULT_CONFIG;
  }
  const user = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<SemanticGrepConfig>;
  return deepMerge(DEFAULT_CONFIG, user);
}
