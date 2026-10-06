import { createStore } from "@nativedesktop/solid";

/// A page kept on purpose. Flat: the sidebar's pinned tabs are where a set of
/// pages is organised; this is the list of addresses worth coming back to.
export interface Bookmark {
  id: string;
  url: string;
  title: string;
  added: number;
}

export interface BookmarksState {
  items: Bookmark[];
}

export const bookmarks = createStore<BookmarksState>({
  name: "bookmarks",
  version: 1,
  defaults: { items: [] },
  dir: process.env.NB_STORE_DIR,
});

export function normalizeBookmarks(state: BookmarksState): BookmarksState {
  const items = Array.isArray(state.items) ? state.items : [];
  return { items: items.filter((b) => b && typeof b.url === "string" && b.url !== "") };
}

export function isBookmarked(url: string): boolean {
  return bookmarks.get().items.some((b) => b.url === url);
}

/// Newest first. Nothing is asked: the title is the page's.
export function addBookmark(url: string, title: string): void {
  if (!url || isBookmarked(url)) return;
  const item: Bookmark = { id: `b${Date.now().toString(36)}`, url, title, added: Date.now() };
  bookmarks.update((s) => ({ items: [item, ...s.items] }));
}

export function removeBookmark(url: string): void {
  bookmarks.update((s) => ({ items: s.items.filter((b) => b.url !== url) }));
}

export function bookmarksMatching(query: string): Bookmark[] {
  const q = query.trim().toLowerCase();
  const items = bookmarks.get().items;
  return q ? items.filter((b) => `${b.title} ${b.url}`.toLowerCase().includes(q)) : items;
}
