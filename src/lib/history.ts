import { mkdirSync } from "node:fs";
import { openDatabase, type SqliteDatabase } from "@nativedesktop/data";
import { ensureAppDataDir } from "@nativedesktop/react";

export interface Visit {
  url: string;
  title: string;
  ts: number;
}

let db: SqliteDatabase | null = null;

export async function openHistory(): Promise<void> {
  const dir = process.env.NB_STORE_DIR ?? ensureAppDataDir();
  mkdirSync(dir, { recursive: true });
  db = await openDatabase(`${dir}/history.sqlite`);
  await db.mutate(
    "CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL)",
  );
}

export async function recordVisit(url: string, title: string): Promise<void> {
  if (!db || !url) return;
  await db.mutate("INSERT INTO visits (url, title, ts) VALUES (?, ?, ?)", [url, title, Date.now()]);
}

/// Titles arrive after the navigation, so backfill the newest row for the URL.
export async function recordTitle(url: string, title: string): Promise<void> {
  if (!db || !url || !title) return;
  await db.mutate(
    "UPDATE visits SET title = ? WHERE id = (SELECT id FROM visits WHERE url = ? ORDER BY id DESC LIMIT 1)",
    [title, url],
  );
}

/// Palette backing search: newest first, one row per URL. An empty query means
/// "most recent", which is what an empty palette should offer.
export async function searchHistory(query: string, limit = 5): Promise<Visit[]> {
  if (!db) return [];
  const q = query.trim();
  if (!q) return recentVisits(limit);
  const like = `%${q}%`;
  return db.query<Visit>(
    "SELECT url, title, MAX(ts) AS ts FROM visits WHERE url LIKE ? OR title LIKE ? GROUP BY url ORDER BY ts DESC LIMIT ?",
    [like, like, limit],
  );
}

/// Addresses the command bar may complete what was typed to, most visited
/// first. Only the host is matched here; completionFor picks the one to use.
export async function completionCandidates(query: string, limit = 8): Promise<string[]> {
  const q = query.trim().toLowerCase();
  if (!db || !q || /\s/.test(q)) return [];
  const p = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const rows = await db.query<{ url: string }>(
    "SELECT url FROM visits WHERE url LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' " +
      "OR url LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' " +
      "GROUP BY url ORDER BY COUNT(*) DESC, MAX(ts) DESC LIMIT ?",
    [`http://${p}%`, `https://${p}%`, `http://www.${p}%`, `https://www.${p}%`, limit],
  );
  return rows.map((r) => r.url);
}

/// Newest first, one row per URL.
export async function recentVisits(limit = 10): Promise<Visit[]> {
  if (!db) return [];
  return db.query<Visit>(
    "SELECT url, title, MAX(ts) AS ts FROM visits GROUP BY url ORDER BY ts DESC LIMIT ?",
    [limit],
  );
}
