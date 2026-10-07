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
function sync(draft: unknown, next: unknown): void {
  if (Array.isArray(draft) && Array.isArray(next)) {
    const byId = new Map<unknown, unknown>();
    for (const row of draft) if (hasId(row)) byId.set(row.id, row);
    const rows = next.map((row: unknown) => {
      const kept = hasId(row) ? byId.get(row.id) : undefined;
      if (kept === undefined) return structuredClone(row);
      sync(kept, row);
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
    if (Array.isArray(value) && Array.isArray(current)) sync(current, value);
    else if (isPlain(value) && isPlain(current) && sameRow) sync(current, value);
    else if (!Object.is(current, value)) draft[key] = typeof value === "object" && value !== null ? structuredClone(value) : value;
  }
}

/// A persisted store as a Solid store that follows it field by field: a new
/// title on one tab reaches what reads that title and nothing else. Read it
/// for rendering; write through the persisted store as before.
export function trackStore<T extends object>(source: Store<T>): T {
  const [state, setState] = createStore<T>(structuredClone(source.get()) as never);
  onCleanup(source.subscribe((next) => setState((draft) => void sync(draft, next))));
  return state;
}
