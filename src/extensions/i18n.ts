// chrome.i18n: message catalogs, locale fallback, and Chrome's substitution
// grammar. Kept free of filesystem and app state so the substitution rules can
// be unit-tested directly.

export interface MessageEntry {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string; example?: string }>;
}

export type MessageCatalog = Record<string, MessageEntry>;

/// Applies Chrome's two substitution forms to one catalog entry:
/// `$1`..`$9` positional arguments, and `$name$` placeholders whose `content`
/// is itself a positional reference. `$$` is a literal dollar sign.
export function applySubstitutions(
  entry: MessageEntry,
  substitutions: string | string[] | undefined,
): string {
  const args = substitutions === undefined ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
  const positional = (index: number): string => args[index - 1] ?? "";

  // Named placeholders first: their content may hold `$1`, which the positional
  // pass below must still see.
  const named = entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (whole, name: string) => {
    const placeholder = entry.placeholders?.[name] ?? entry.placeholders?.[name.toLowerCase()];
    return placeholder ? placeholder.content : whole;
  });

  return named.replace(/\$(\$|[1-9])/g, (_, token: string) => (token === "$" ? "$" : positional(Number(token))));
}

/// Resolves `__MSG_key__` references, which appear in manifest fields long
/// before any page can call `chrome.i18n.getMessage`.
export function resolveMessageRefs(value: string, lookup: (key: string) => string | null): string {
  return value.replace(/__MSG_([A-Za-z0-9_@]+)__/g, (whole, key: string) => lookup(key) ?? whole);
}

/// The locales to try, most specific first: the requested locale, its base
/// language, and the extension's declared default.
export function localeChain(uiLocale: string, defaultLocale: string): string[] {
  const normalized = uiLocale.replace("-", "_");
  const chain = [normalized];
  const base = normalized.split("_")[0]!;
  if (base !== normalized) chain.push(base);
  if (!chain.includes(defaultLocale)) chain.push(defaultLocale);
  return chain;
}

export class Messages {
  private readonly catalogs: MessageCatalog[];

  constructor(catalogs: MessageCatalog[]) {
    this.catalogs = catalogs;
  }

  /** Chrome returns the empty string, never undefined, for an unknown key. */
  get(key: string, substitutions?: string | string[]): string {
    for (const catalog of this.catalogs) {
      const entry = catalog[key] ?? catalog[key.toLowerCase()];
      if (entry) return applySubstitutions(entry, substitutions);
    }
    return "";
  }

  has(key: string): boolean {
    return this.catalogs.some((c) => c[key] !== undefined || c[key.toLowerCase()] !== undefined);
  }
}
