import { describe, expect, it } from "vitest";
import {
  extractTerms,
  normalizeKeyword,
  rankGaps,
  scoreTerms,
  STOPWORDS,
  type ScoredTerm,
} from "./YoutubeKeywordTerms";

describe("normalizeKeyword", () => {
  it("trims, lowercases, and collapses whitespace", () => {
    expect(normalizeKeyword("  Best   Minecraft \n Songs ")).toBe(
      "best minecraft songs",
    );
  });

  it("strips a leading hash", () => {
    expect(normalizeKeyword("#Shorts")).toBe("shorts");
    expect(normalizeKeyword("##minecraft")).toBe("minecraft");
  });

  it("returns an empty string for blank and hash-only input", () => {
    expect(normalizeKeyword("   ")).toBe("");
    expect(normalizeKeyword("#")).toBe("");
  });
});

describe("STOPWORDS", () => {
  it("covers function words and YouTube boilerplate", () => {
    for (const word of [
      "the",
      "and",
      "of",
      "official",
      "video",
      "full",
      "hd",
      "4k",
      "live",
      "new",
      "best",
      "song",
      "songs",
      "mix",
      "playlist",
      "subscribe",
      "channel",
      "2024",
      "2025",
      "2026",
      "feat",
      "ft",
      "lyrics",
      "audio",
      "version",
      "reaction",
    ]) {
      expect(STOPWORDS.has(word), word).toBe(true);
    }
  });
});

describe("extractTerms", () => {
  it("keeps whole tags and drops stopword-bearing tags", () => {
    expect(
      extractTerms({
        title: "",
        tags: ["minecraft survival", "official video", "redstone tutorial"],
      }),
    ).toEqual(["minecraft survival", "redstone tutorial"]);
  });

  it("builds title n-grams of 2..4 tokens and drops stopword n-grams", () => {
    expect(
      extractTerms({
        title: "Minecraft Survival Guide for Beginners",
        tags: ["minecraft survival", "official video"],
      }),
    ).toEqual([
      "minecraft survival",
      "minecraft survival guide",
      "survival guide",
    ]);
  });

  it("puts tags first and dedupes in first-seen order", () => {
    expect(
      extractTerms({
        title: "Minecraft Survival Guide",
        tags: ["survival guide"],
      }),
    ).toEqual([
      "survival guide",
      "minecraft survival",
      "minecraft survival guide",
    ]);
  });

  it("drops short, long, numeric-only, and symbol-only terms", () => {
    expect(
      extractTerms({
        title: "100 200 300",
        tags: ["x", "12 34", "a".repeat(61), "ab"],
      }),
    ).toEqual(["ab"]);
  });

  it("trims edge punctuation from title tokens", () => {
    expect(extractTerms({ title: "Minecraft (Survival) Guide!" })).toEqual([
      "minecraft survival",
      "minecraft survival guide",
      "survival guide",
    ]);
  });

  it("returns an empty list when nothing survives filtering", () => {
    expect(extractTerms({ title: "Official Video", tags: ["live"] })).toEqual(
      [],
    );
  });
});

describe("scoreTerms", () => {
  it("requires two videos, medians scores, averages views, and ranks", () => {
    const scored = scoreTerms([
      {
        videoId: "v1",
        terms: ["minecraft survival"],
        outlierScore: 4,
        views: 1000,
      },
      {
        videoId: "v2",
        terms: ["minecraft survival"],
        outlierScore: 2,
        views: 500,
      },
      {
        videoId: "v3",
        terms: ["minecraft survival"],
        outlierScore: 6,
        views: 300,
      },
      {
        videoId: "v4",
        terms: ["rare term"],
        outlierScore: 10,
        views: 100,
      },
      {
        videoId: "v5",
        terms: ["minecraft survival", "redstone"],
        outlierScore: 3,
        views: 400,
      },
      {
        videoId: "v6",
        terms: ["redstone", "redstone"],
        outlierScore: 1,
        views: null,
      },
    ]);

    expect(scored.map((term) => term.term)).toEqual([
      "minecraft survival",
      "redstone",
    ]);
    const [survival, redstone] = scored;
    expect(survival).toEqual({
      term: "minecraft survival",
      videoCount: 4,
      medianOutlierScore: 3.5,
      averageViews: 550,
      exampleVideoIds: ["v3", "v1", "v5"],
    });
    expect(redstone).toEqual({
      term: "redstone",
      videoCount: 2,
      medianOutlierScore: 2,
      averageViews: 200,
      exampleVideoIds: ["v5", "v6"],
    });
  });

  it("sorts by median outlier score then video count", () => {
    const scored = scoreTerms([
      { videoId: "a", terms: ["low"], outlierScore: 1, views: 10 },
      { videoId: "b", terms: ["low"], outlierScore: 3, views: 10 },
      { videoId: "c", terms: ["high"], outlierScore: 5, views: 10 },
      { videoId: "d", terms: ["high"], outlierScore: 5, views: 10 },
      { videoId: "e", terms: ["high"], outlierScore: 5, views: 10 },
    ]);

    expect(scored.map((term) => term.term)).toEqual(["high", "low"]);
  });
});

function scoredTerm(overrides: Partial<ScoredTerm> = {}): ScoredTerm {
  return {
    term: "term",
    videoCount: 2,
    medianOutlierScore: 2,
    averageViews: 100,
    exampleVideoIds: [],
    ...overrides,
  };
}

describe("rankGaps", () => {
  it("returns competitor terms you lack, above the video floor, by score", () => {
    const you = [scoredTerm({ term: "minecraft survival" })];
    const competitor = [
      scoredTerm({ term: "minecraft survival", medianOutlierScore: 9 }),
      scoredTerm({
        term: "redstone tutorial",
        videoCount: 3,
        medianOutlierScore: 5,
      }),
      scoredTerm({ term: "rare topic", videoCount: 1, medianOutlierScore: 9 }),
    ];

    expect(rankGaps(you, competitor, 2).map((term) => term.term)).toEqual([
      "redstone tutorial",
    ]);
  });

  it("matches owned terms exactly after normalization", () => {
    const you = [scoredTerm({ term: "minecraft survival" })];
    const competitor = [
      scoredTerm({ term: "  Minecraft   Survival ", medianOutlierScore: 9 }),
      scoredTerm({ term: "survival guide", medianOutlierScore: 4 }),
    ];

    expect(rankGaps(you, competitor, 2).map((term) => term.term)).toEqual([
      "survival guide",
    ]);
  });

  it("sorts gaps by median outlier score desc", () => {
    const competitor = [
      scoredTerm({ term: "low", medianOutlierScore: 2 }),
      scoredTerm({ term: "high", medianOutlierScore: 8 }),
    ];

    expect(rankGaps([], competitor, 2).map((term) => term.term)).toEqual([
      "high",
      "low",
    ]);
  });
});
