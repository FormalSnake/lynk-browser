// Everything about an extension that has to outlive the process: which ones
// are installed, whether the user enabled them, what they were granted, and
// the contents of their chrome.storage areas. Same SQLite file as history,
// same @nativedesktop/data path.
import { mkdirSync } from "node:fs";
import { openDatabase, type SqliteDatabase } from "@nativedesktop/data";
import { ensureAppDataDir } from "@nativedesktop/react";

export interface InstalledRecord {
  id: string;
  root: string;
  enabled: boolean;
  granted: string[];
  installedAt: number;
}

export type StorageArea = "local" | "sync" | "session";

let db: SqliteDatabase | null = null;

export function extensionsDir(): string {
  const dir = `${process.env.NB_STORE_DIR ?? ensureAppDataDir()}/extensions`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function openRegistry(): Promise<void> {
  const dir = process.env.NB_STORE_DIR ?? ensureAppDataDir();
  mkdirSync(dir, { recursive: true });
  db = await openDatabase(`${dir}/extensions.sqlite`);
  await db.mutate(
    "CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, root TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, granted TEXT NOT NULL DEFAULT '[]', installed_at INTEGER NOT NULL)",
  );
  await db.mutate(
    "CREATE TABLE IF NOT EXISTS extension_storage (ext_id TEXT NOT NULL, area TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (ext_id, area, key))",
  );
}

interface Row {
  id: string;
  root: string;
  enabled: number;
  granted: string;
  installed_at: number;
}

function toRecord(row: Row): InstalledRecord {
  let granted: string[] = [];
  try {
    granted = JSON.parse(row.granted);
  } catch {
    granted = [];
  }
  return { id: row.id, root: row.root, enabled: row.enabled !== 0, granted, installedAt: row.installed_at };
}

export async function listInstalled(): Promise<InstalledRecord[]> {
  if (!db) return [];
  const rows = await db.query<Row>("SELECT id, root, enabled, granted, installed_at FROM extensions ORDER BY installed_at");
  return rows.map(toRecord);
}

export async function upsertInstalled(record: InstalledRecord): Promise<void> {
  if (!db) return;
  await db.mutate(
    "INSERT INTO extensions (id, root, enabled, granted, installed_at) VALUES (?, ?, ?, ?, ?)" +
      " ON CONFLICT(id) DO UPDATE SET root = excluded.root, enabled = excluded.enabled, granted = excluded.granted",
    [record.id, record.root, record.enabled ? 1 : 0, JSON.stringify(record.granted), record.installedAt],
  );
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  if (!db) return;
  await db.mutate("UPDATE extensions SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]);
}

export async function removeInstalled(id: string): Promise<void> {
  if (!db) return;
  await db.mutate("DELETE FROM extensions WHERE id = ?", [id]);
  await db.mutate("DELETE FROM extension_storage WHERE ext_id = ?", [id]);
}

/// One extension's whole area, as the values chrome.storage speaks in. Session
/// storage is deliberately not persisted: Chrome clears it on restart.
export async function readArea(id: string, area: StorageArea): Promise<Record<string, unknown>> {
  if (!db || area === "session") return {};
  const rows = await db.query<{ key: string; value: string }>(
    "SELECT key, value FROM extension_storage WHERE ext_id = ? AND area = ?",
    [id, area],
  );
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      // A value that no longer parses is treated as absent rather than crashing the read.
    }
  }
  return out;
}

export async function writeArea(id: string, area: StorageArea, items: Record<string, unknown>): Promise<void> {
  if (!db || area === "session") return;
  const steps = Object.entries(items).map(([key, value]) => ({
    sql: "INSERT INTO extension_storage (ext_id, area, key, value) VALUES (?, ?, ?, ?)" +
      " ON CONFLICT(ext_id, area, key) DO UPDATE SET value = excluded.value",
    params: [id, area, key, JSON.stringify(value ?? null)] as (string | number)[],
  }));
  if (steps.length > 0) await db.transaction(steps);
}

export async function deleteKeys(id: string, area: StorageArea, keys: string[]): Promise<void> {
  if (!db || area === "session" || keys.length === 0) return;
  await db.transaction(
    keys.map((key) => ({
      sql: "DELETE FROM extension_storage WHERE ext_id = ? AND area = ? AND key = ?",
      params: [id, area, key] as string[],
    })),
  );
}

export async function clearArea(id: string, area: StorageArea): Promise<void> {
  if (!db || area === "session") return;
  await db.mutate("DELETE FROM extension_storage WHERE ext_id = ? AND area = ?", [id, area]);
}
