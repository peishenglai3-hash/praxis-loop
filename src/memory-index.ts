/** Rebuild the FTS projection when this preprocessing version changes. */
export const SEARCH_TERMS_VERSION = "1";

export interface FtsQuery {
  version: string;
  match: string;
  terms: string[];
  /** Index term -> normalized query fragments that produced it. */
  termMap: Record<string, string[]>;
}

/**
 * The FTS table must use unicode61 with tokenchars '_' to retain snake_case.
 * These functions only prepare text; they neither query nor mutate SQLite.
 */
function collectTerms(text: string, query: boolean): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const add = (term: string, fragment: string): void => {
    if (!term || !/[\p{L}\p{N}]/u.test(term)) return;
    const sources = result.get(term);
    if (!sources) result.set(term, [fragment]);
    else if (!sources.includes(fragment)) sources.push(fragment);
  };

  const normalized = text.normalize("NFKC");
  const fragments = normalized.match(/\p{Script=Han}+|[\p{Script=Latin}\p{N}_]+/gu) ?? [];
  for (const fragment of fragments) {
    if (/^\p{Script=Han}+$/u.test(fragment)) {
      const characters = Array.from(fragment);
      if (!query || characters.length === 1) {
        for (const character of characters) add(character, fragment);
      }
      for (let index = 0; index + 1 < characters.length; index++) {
        add(characters[index]! + characters[index + 1]!, fragment);
      }
      continue;
    }

    add(fragment.toLowerCase(), fragment);
    const split = fragment
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
      .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
      .split(/[_\s]+/u);
    for (const part of split) add(part.toLowerCase(), fragment);
  }
  return result;
}

/** Stable, deduplicated lexical terms for a rebuildable FTS search_terms column. */
export function buildSearchTerms(text: string): string {
  return [...collectTerms(text, false).keys()].join(" ");
}

/** User input is always literal terms, never an FTS operator expression. */
export function buildFtsQuery(query: string): FtsQuery | null {
  const collected = collectTerms(query, true);
  const terms = [...collected.keys()];
  if (terms.length === 0) return null;
  return {
    version: SEARCH_TERMS_VERSION,
    match: terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR "),
    terms,
    termMap: Object.fromEntries(collected),
  };
}
