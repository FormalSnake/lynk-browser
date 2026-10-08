import { createStore, onCleanup } from "solid-js";
import type { Store } from "@nativedesktop/react";

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasId(v: unknown): v is Plain & { id: unknown } {
  return isPlain(v) && "id" in v;
}

/// Writes only what differs between `draft` and `next` into the draft. Rows
/// carrying an `id` are matched by it rather than by position, so a row that
/// moves (a tab dragged to another place, or into another window's list)
/// keeps its proxy. What goes in is a copy: the persisted store's values are
/// shared between its snapshots and must never be written through.
///
/// `prev` is the snapshot the draft was last synced to. Every update builds
/// its snapshot from the last one, so a part that is the very same object is
/// unchanged and is skipped, and where rows keep their places the plain
/// snapshots say what changed without a read through the draft's proxy: a
/// tab switch writes one field and walks nothing else.
function sync(draft: unknown, next: unknown, prev: unknown): void {
  if (next === prev) return;
  if (Array.isArray(next) && Array.isArray(prev) && sameRows(next, prev)) {
    const rows = draft as unknown[];
    for (let i = 0; i < next.length; i++) {
      if (next[i] === prev[i]) continue;
      if (isPlain(next[i]) && isPlain(prev[i])) sync(rows[i], next[i], prev[i]);
      else rows[i] = copy(next[i]);
    }
    return;
  }
  if (isPlain(next) && isPlain(prev)) {
    const fields = draft as Plain;
    for (const key of Object.keys(prev)) if (!(key in next)) delete fields[key];
    for (const key of Object.keys(next)) {
      const value = next[key];
      const before = prev[key];
      if (Object.is(value, before)) continue;
      const sameRow = !hasId(value) || !hasId(before) || value.id === before.id;
      if ((Array.isArray(value) && Array.isArray(before)) || (isPlain(value) && isPlain(before) && sameRow)) {
        sync(fields[key], value, before);
      } else {
        fields[key] = copy(value);
      }
    }
    return;
  }
  reconcile(draft, next);
}

/// Whether two lists hold the same rows in the same places: the same ids, or
/// no id at either.
function sameRows(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if ((hasId(x) ? x.id : undefined) !== (hasId(y) ? y.id : undefined)) return false;
  }
  return true;
}

function copy(value: unknown): unknown {
  return typeof value === "object" && value !== null ? structuredClone(value) : value;
}

/// The general case, read off the draft itself: rows that moved, came or went.
function reconcile(draft: unknown, next: unknown): void {
  if (Array.isArray(draft) && Array.isArray(next)) {
    const byId = new Map<unknown, unknown>();
    for (const row of draft) if (hasId(row)) byId.set(row.id, row);
    const rows = next.map((row: unknown) => {
      const kept = hasId(row) ? byId.get(row.id) : undefined;
      if (kept === undefined) return structuredClone(row);
      reconcile(kept, row);
      return kept;
    });
    for (let i = 0; i < rows.length; i++) if (draft[i] !== rows[i]) draft[i] = rows[i];
    if (draft.length !== rows.length) draft.length = rows.length;
    return;
  }
  if (!isPlain(draft) || !isPlain(next)) return;
  for (const key of Object.keys(draft)) if (!(key in next)) delete draft[key];
  for (const [key, value] of Object.entries(next)) {
    const current = draft[key];
    const sameRow = !hasId(value) || !hasId(current) || value.id === current.id;
    if (Array.isArray(value) && Array.isArray(current)) reconcile(current, value);
    else if (isPlain(value) && isPlain(current) && sameRow) reconcile(current, value);
    else if (!Object.is(current, value)) draft[key] = copy(value);
  }
}

/// A persisted store as a Solid store that follows it field by field: a new
/// title on one tab reaches what reads that title and nothing else. Read it
/// for rendering; write through the persisted store as before.
export function trackStore<T extends object>(source: Store<T>): T {
  let last: unknown = source.get();
  const [state, setState] = createStore<T>(structuredClone(last) as never);
  onCleanup(
    source.subscribe((next) => {
      const prev = last;
      last = next;
      setState((draft) => void sync(draft, next, prev));
    }),
  );
  return state;
}
