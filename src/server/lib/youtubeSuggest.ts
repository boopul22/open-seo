// YouTube autocomplete (suggest) is public and unauthenticated: no API key and
// no YouTube Data API quota. It returns the strings YouTube autocompletes in
// its search box — query ideas, not search volume.

export const SUGGEST_ENDPOINT =
  "https://suggestqueries.google.com/complete/search";
export const SUGGEST_DEFAULT_LIMIT = 25;
export const SUGGEST_MAX_LIMIT = 50;

export function clampSuggestLimit(limit: number): number {
  if (!Number.isFinite(limit)) return SUGGEST_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), SUGGEST_MAX_LIMIT);
}

/** The public autocomplete URL. `limit` is requested as `num`, but the
 *  endpoint returns its own fixed-size list, so callers must still truncate
 *  parsed suggestions to `limit`. */
export function SUGGEST_URL(query: string, limit: number): string {
  const url = new URL(SUGGEST_ENDPOINT);
  url.searchParams.set("client", "youtube");
  url.searchParams.set("ds", "yt");
  url.searchParams.set("hl", "en");
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(clampSuggestLimit(limit)));
  return url.toString();
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Suggestion rows are `[suggestionText, relevance, ...]` tuples. */
function isSuggestionTuple(value: unknown): value is [string, ...unknown[]] {
  return isUnknownArray(value) && typeof value[0] === "string";
}

/**
 * Parse the JSONP-ish suggest body (`window.google.ac.h([...])`) into
 * suggestion strings. Returns null when the body isn't a recognizable
 * suggestion payload — so callers can tell "autocomplete unavailable" from
 * "no suggestions" — and [] when the payload is valid but empty. Pure.
 */
export function parseSuggestBody(body: string): string[] | null {
  const start = body.indexOf("(");
  const end = body.lastIndexOf(")");
  if (start === -1 || end <= start) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(body.slice(start + 1, end));
  } catch {
    return null;
  }
  if (!isUnknownArray(payload) || !isUnknownArray(payload[1])) return null;

  const hints: string[] = [];
  for (const entry of payload[1]) {
    if (!isSuggestionTuple(entry)) continue;
    const hint = entry[0].trim();
    if (hint !== "") hints.push(hint);
  }
  return hints;
}
