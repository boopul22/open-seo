import { describe, expect, it } from "vitest";
import {
  clampSuggestLimit,
  parseSuggestBody,
  SUGGEST_URL,
} from "./youtubeSuggest";

// Captured from
// https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&hl=en&q=minecraft
const REALISTIC_BODY =
  'window.google.ac.h(["minecraft",[["minecraft",0,[512]],["minecraft video",0,[512,433]],["minecraft house",0,[512,433]],["minecraft song",0,[512,433]]],{"k":1}])';

describe("parseSuggestBody", () => {
  it("parses suggestion tuples out of the JSONP wrapper", () => {
    expect(parseSuggestBody(REALISTIC_BODY)).toEqual([
      "minecraft",
      "minecraft video",
      "minecraft house",
      "minecraft song",
    ]);
  });

  it("returns an empty list for a valid payload with no suggestions", () => {
    expect(parseSuggestBody('window.google.ac.h(["query",[]])')).toEqual([]);
  });

  it("returns null when the wrapper has no JSON payload", () => {
    expect(parseSuggestBody("window.google.ac.h(")).toBeNull();
    expect(parseSuggestBody("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseSuggestBody("window.google.ac.h([not json])")).toBeNull();
  });

  it("returns null when the payload is not a suggestion list", () => {
    expect(parseSuggestBody('window.google.ac.h({"error":"nope"})')).toBeNull();
    expect(parseSuggestBody('window.google.ac.h(["query","nope"])')).toBeNull();
  });

  it("skips entries that are not [string, ...] tuples or are blank", () => {
    expect(
      parseSuggestBody(
        'window.google.ac.h(["query",[[1,0],["ok"],[],["  padded  "]]])',
      ),
    ).toEqual(["ok", "padded"]);
  });
});

describe("SUGGEST_URL", () => {
  it("builds the public autocomplete URL with the query encoded", () => {
    const url = new URL(SUGGEST_URL("minecraft tips & tricks", 25));
    expect(url.origin + url.pathname).toBe(
      "https://suggestqueries.google.com/complete/search",
    );
    expect(url.searchParams.get("client")).toBe("youtube");
    expect(url.searchParams.get("ds")).toBe("yt");
    expect(url.searchParams.get("hl")).toBe("en");
    expect(url.searchParams.get("q")).toBe("minecraft tips & tricks");
    expect(url.searchParams.get("num")).toBe("25");
  });

  it("clamps the requested count to 1..50", () => {
    expect(new URL(SUGGEST_URL("q", 0)).searchParams.get("num")).toBe("1");
    expect(new URL(SUGGEST_URL("q", 500)).searchParams.get("num")).toBe("50");
  });
});

describe("clampSuggestLimit", () => {
  it("passes through in-range limits", () => {
    expect(clampSuggestLimit(25)).toBe(25);
    expect(clampSuggestLimit(1)).toBe(1);
    expect(clampSuggestLimit(50)).toBe(50);
  });

  it("floors non-finite input to the default", () => {
    expect(clampSuggestLimit(Number.NaN)).toBe(25);
    expect(clampSuggestLimit(Number.POSITIVE_INFINITY)).toBe(25);
  });
});
