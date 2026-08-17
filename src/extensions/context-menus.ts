// `chrome.contextMenus`, the model half. The broker owns what each extension
// has registered; the framework owns what a right-click actually shows. This
// module is the translation between the two, and it is where Chrome's rules
// live: radio groups, checkbox round trips, URL-pattern filtering, and the
// grouping convention every browser uses when one extension registers more
// than one item.
import { compileMatcher, matcherAccepts } from "./match-patterns.ts";
import type { ContextMenuItem } from "@nativedesktop/react";

export type MenuItemType = "normal" | "checkbox" | "radio" | "separator";

export interface MenuEntry {
  id: string;
  title: string;
  type: MenuItemType;
  checked: boolean;
  enabled: boolean;
  visible: boolean;
  /** Chrome's context names, unfiltered: the mapping drops what we cannot show. */
  contexts: string[];
  parentId: string | null;
  documentUrlPatterns: string[] | null;
  targetUrlPatterns: string[] | null;
}

export interface MenuProps {
  id?: string;
  title?: string;
  type?: string;
  checked?: boolean;
  enabled?: boolean;
  visible?: boolean;
  contexts?: string[];
  parentId?: string | number;
  documentUrlPatterns?: string[];
  targetUrlPatterns?: string[];
}

/// Chrome contexts the framework can express. `frame` is folded into `page`
/// (the framework has no per-frame hit test); `video`, `audio` and the
/// browser-surface contexts have no page-menu meaning here, so an item that
/// asks for nothing else is dropped rather than shown in the wrong place.
const CONTEXT_MAP: Record<string, string[]> = {
  all: ["page", "link", "image", "selection", "editable"],
  page: ["page"],
  frame: ["page"],
  link: ["link"],
  image: ["image"],
  selection: ["selection"],
  editable: ["editable"],
};

export function frameworkContexts(contexts: string[]): string[] {
  const out = new Set<string>();
  for (const name of contexts) {
    for (const mapped of CONTEXT_MAP[name] ?? []) out.add(mapped);
  }
  return [...out];
}

/// The framework id an extension's item travels under. The extension id is a
/// fixed 32-character token, so the entry id (which may itself contain colons)
/// is everything after the second one.
export function frameworkId(extensionId: string, entryId: string): string {
  return `ext:${extensionId}:${entryId}`;
}

export function parseFrameworkId(id: string): { extensionId: string; entryId: string } | null {
  if (!id.startsWith("ext:")) return null;
  const rest = id.slice(4);
  const cut = rest.indexOf(":");
  if (cut < 0) return null;
  return { extensionId: rest.slice(0, cut), entryId: rest.slice(cut + 1) };
}

function matchesPatterns(patterns: string[] | null, url: string): boolean {
  if (patterns === null || patterns.length === 0) return true;
  if (!url) return false;
  return matcherAccepts(compileMatcher(patterns), url);
}

export class ContextMenuRegistry {
  /** Extension id -> its items, in registration order. */
  private items = new Map<string, MenuEntry[]>();
  private counter = 0;

  create(extensionId: string, props: MenuProps): string {
    const entries = this.items.get(extensionId) ?? [];
    const id = String(props.id ?? `nb-menu-${++this.counter}`);
    const entry: MenuEntry = {
      id,
      title: String(props.title ?? ""),
      type: menuType(props.type),
      checked: props.checked === true,
      enabled: props.enabled !== false,
      visible: props.visible !== false,
      contexts: props.contexts?.length ? props.contexts.map(String) : ["page"],
      parentId: props.parentId === undefined ? null : String(props.parentId),
      documentUrlPatterns: props.documentUrlPatterns ?? null,
      targetUrlPatterns: props.targetUrlPatterns ?? null,
    };
    const at = entries.findIndex((e) => e.id === id);
    if (at >= 0) entries[at] = entry;
    else entries.push(entry);
    this.items.set(extensionId, entries);
    if (entry.type === "radio" && entry.checked) this.uncheckSiblings(extensionId, entry);
    return id;
  }

  update(extensionId: string, id: string, props: MenuProps): boolean {
    const entry = this.entry(extensionId, id);
    if (!entry) return false;
    if (props.title !== undefined) entry.title = String(props.title);
    if (props.type !== undefined) entry.type = menuType(props.type);
    if (props.enabled !== undefined) entry.enabled = props.enabled !== false;
    if (props.visible !== undefined) entry.visible = props.visible !== false;
    if (props.contexts !== undefined && props.contexts.length > 0) entry.contexts = props.contexts.map(String);
    if (props.parentId !== undefined) entry.parentId = props.parentId === null ? null : String(props.parentId);
    if (props.documentUrlPatterns !== undefined) entry.documentUrlPatterns = props.documentUrlPatterns;
    if (props.targetUrlPatterns !== undefined) entry.targetUrlPatterns = props.targetUrlPatterns;
    if (props.checked !== undefined) this.setChecked(extensionId, entry, props.checked === true);
    return true;
  }

  /// Chrome removes a subtree, not a row: a parent's children have nowhere left
  /// to hang.
  remove(extensionId: string, id: string): void {
    const entries = this.items.get(extensionId);
    if (!entries) return;
    const doomed = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const entry of entries) {
        if (entry.parentId !== null && doomed.has(entry.parentId) && !doomed.has(entry.id)) {
          doomed.add(entry.id);
          grew = true;
        }
      }
    }
    this.items.set(
      extensionId,
      entries.filter((e) => !doomed.has(e.id)),
    );
  }

  removeAll(extensionId: string): void {
    this.items.delete(extensionId);
  }

  forget(extensionId: string): void {
    this.items.delete(extensionId);
  }

  entries(extensionId: string): MenuEntry[] {
    return this.items.get(extensionId) ?? [];
  }

  entry(extensionId: string, id: string): MenuEntry | null {
    return this.items.get(extensionId)?.find((e) => e.id === id) ?? null;
  }

  extensionIds(): string[] {
    return [...this.items.keys()];
  }

  /// A click lands on the model before it reaches the extension: a checkbox
  /// toggles, a radio takes the group. Returns what the `onClicked` info should
  /// report, which is Chrome's `checked` (after) and `wasChecked` (before).
  applyClick(extensionId: string, entry: MenuEntry): { checked?: boolean; wasChecked?: boolean } {
    if (entry.type === "checkbox") {
      const wasChecked = entry.checked;
      entry.checked = !wasChecked;
      return { checked: entry.checked, wasChecked };
    }
    if (entry.type === "radio") {
      const wasChecked = entry.checked;
      this.setChecked(extensionId, entry, true);
      return { checked: true, wasChecked };
    }
    return {};
  }

  private setChecked(extensionId: string, entry: MenuEntry, checked: boolean): void {
    entry.checked = checked;
    if (entry.type === "radio" && checked) this.uncheckSiblings(extensionId, entry);
  }

  /// A radio group is the run of radio items registered next to each other
  /// under the same parent, which is exactly how Chrome groups them.
  private uncheckSiblings(extensionId: string, entry: MenuEntry): void {
    const entries = this.items.get(extensionId) ?? [];
    const at = entries.indexOf(entry);
    if (at < 0) return;
    for (let i = at - 1; i >= 0; i--) {
      if (entries[i]!.type !== "radio" || entries[i]!.parentId !== entry.parentId) break;
      entries[i]!.checked = false;
    }
    for (let i = at + 1; i < entries.length; i++) {
      if (entries[i]!.type !== "radio" || entries[i]!.parentId !== entry.parentId) break;
      entries[i]!.checked = false;
    }
  }

  /// The framework tree for one page: every enabled extension's items that
  /// could show on this URL, in the order they were registered.
  ///
  /// Chrome's grouping convention: one item from an extension sits inline at
  /// the top level, several are collected under a single entry titled with the
  /// extension's name. Chrome counts the items that match the CLICK; the tree
  /// is sent ahead of the click here, so the count is of what could match this
  /// PAGE. The difference shows only when an extension registers several items
  /// and just one of them matches a given hit: Chrome would inline it, this
  /// leaves it one level down.
  itemsForPage(extensions: { id: string; name: string }[], pageUrl: string): ContextMenuItem[] {
    const out: ContextMenuItem[] = [];
    for (const extension of extensions) {
      const entries = (this.items.get(extension.id) ?? []).filter(
        (e) => e.visible && matchesPatterns(e.documentUrlPatterns, pageUrl),
      );
      if (entries.length === 0) continue;
      const roots = entries.filter((e) => e.parentId === null);
      const items = roots
        .map((root) => this.toItem(extension.id, root, entries))
        .filter((item): item is ContextMenuItem => item !== null);
      if (items.length === 0) continue;
      if (items.length === 1) {
        out.push(items[0]!);
        continue;
      }
      out.push({
        id: frameworkId(extension.id, "__group__"),
        label: extension.name,
        contexts: unionContexts(items) as ContextMenuItem["contexts"],
        children: items,
      });
    }
    return out;
  }

  private toItem(extensionId: string, entry: MenuEntry, pool: MenuEntry[]): ContextMenuItem | null {
    if (entry.type === "separator") return { type: "separator" };
    if (!entry.title) return null;
    const children = pool
      .filter((e) => e.parentId === entry.id)
      .map((child) => this.toItem(extensionId, child, pool))
      .filter((item): item is ContextMenuItem => item !== null);
    const own = frameworkContexts(entry.contexts);
    if (own.length === 0 && children.length === 0) return null;
    const item: ContextMenuItem = {
      id: frameworkId(extensionId, entry.id),
      label: entry.title,
      contexts: (children.length > 0
        ? [...new Set([...own, ...unionContexts(children)])]
        : own) as ContextMenuItem["contexts"],
    };
    if (entry.type !== "normal") item.type = entry.type;
    if (entry.type === "checkbox" || entry.type === "radio") item.checked = entry.checked;
    if (!entry.enabled) item.enabled = false;
    // Chrome's targetUrlPatterns ride along as globs: the grammars are shaped
    // the same, and the click is re-checked against the real pattern engine
    // before the extension is told about it (see `clickAllowed`).
    if (entry.targetUrlPatterns && entry.targetUrlPatterns.length > 0) {
      item.targetUrlGlobs = entry.targetUrlPatterns;
    }
    if (children.length > 0) item.children = children;
    return item;
  }

  /// The framework filters on globs, which can be looser than a match pattern.
  /// This is the exact check, run before the extension hears about the click.
  clickAllowed(entry: MenuEntry, pageUrl: string, targetUrl: string): boolean {
    if (!matchesPatterns(entry.documentUrlPatterns, pageUrl)) return false;
    if (entry.targetUrlPatterns === null || entry.targetUrlPatterns.length === 0) return true;
    return matchesPatterns(entry.targetUrlPatterns, targetUrl);
  }
}

function unionContexts(items: ContextMenuItem[]): string[] {
  const out = new Set<string>();
  for (const item of items) {
    for (const context of item.contexts ?? []) out.add(String(context));
  }
  return [...out];
}

function menuType(raw: unknown): MenuItemType {
  const value = String(raw ?? "normal");
  return value === "checkbox" || value === "radio" || value === "separator" ? value : "normal";
}
