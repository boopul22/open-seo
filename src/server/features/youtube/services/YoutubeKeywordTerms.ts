import { sort } from "remeda";
import { median, round2 } from "./YoutubeOutlierMath";

// English function words plus YouTube boilerplate that says nothing about a
// video's topic. A term containing any of these is not a keyword candidate.
export const STOPWORDS: ReadonlySet<string> = new Set([
  // Articles, determiners, pronouns.
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "some",
  "any",
  "each",
  "every",
  "all",
  "both",
  "either",
  "neither",
  "another",
  "other",
  "such",
  "i",
  "me",
  "my",
  "mine",
  "myself",
  "you",
  "your",
  "yours",
  "yourself",
  "he",
  "him",
  "his",
  "himself",
  "she",
  "her",
  "hers",
  "herself",
  "it",
  "its",
  "itself",
  "we",
  "us",
  "our",
  "ours",
  "ourselves",
  "they",
  "them",
  "their",
  "theirs",
  "themselves",
  "who",
  "whom",
  "whose",
  "which",
  "what",
  "whatever",
  "whoever",
  // Prepositions.
  "about",
  "above",
  "across",
  "after",
  "against",
  "along",
  "among",
  "around",
  "at",
  "before",
  "behind",
  "below",
  "beneath",
  "beside",
  "between",
  "beyond",
  "by",
  "despite",
  "down",
  "during",
  "except",
  "for",
  "from",
  "in",
  "inside",
  "into",
  "like",
  "near",
  "of",
  "off",
  "on",
  "onto",
  "out",
  "outside",
  "over",
  "past",
  "since",
  "through",
  "throughout",
  "till",
  "to",
  "toward",
  "towards",
  "under",
  "underneath",
  "until",
  "up",
  "upon",
  "with",
  "within",
  "without",
  // Conjunctions.
  "and",
  "or",
  "but",
  "nor",
  "so",
  "yet",
  "if",
  "then",
  "than",
  "because",
  "although",
  "though",
  "while",
  "whereas",
  "unless",
  "whether",
  "as",
  // Auxiliaries and modals.
  "am",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "doing",
  "done",
  "have",
  "has",
  "had",
  "having",
  "will",
  "would",
  "shall",
  "should",
  "can",
  "could",
  "may",
  "might",
  "must",
  // Adverbs and connectives.
  "not",
  "no",
  "very",
  "just",
  "too",
  "also",
  "only",
  "even",
  "ever",
  "never",
  "always",
  "often",
  "sometimes",
  "again",
  "still",
  "already",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "more",
  "most",
  "much",
  "many",
  "few",
  "less",
  "least",
  "own",
  "same",
  // YouTube boilerplate.
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
]);

const MIN_TERM_LENGTH = 2;
const MAX_TERM_LENGTH = 60;
const MIN_NGRAM_LENGTH = 2;
const MAX_NGRAM_LENGTH = 4;
const MIN_VIDEOS_PER_TERM = 2;
const MAX_EXAMPLE_VIDEO_IDS = 3;

const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** Canonical form for a keyword or phrase: trimmed, lowercased, whitespace
 *  collapsed, and with any leading "#" removed. Pure. */
export function normalizeKeyword(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^#+/, "")
    .trim()
    .replace(/\s+/g, " ");
}

/** Title/tag text to comparable word tokens, punctuation trimmed from edges. */
function tokenize(value: string): string[] {
  return normalizeKeyword(value)
    .split(" ")
    .map((token) => token.replace(EDGE_PUNCTUATION, ""))
    .filter((token) => token !== "");
}

function isCandidateTerm(term: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  if (term.length < MIN_TERM_LENGTH || term.length > MAX_TERM_LENGTH) {
    return false;
  }
  if (tokens.some((token) => STOPWORDS.has(token))) return false;
  // Purely numeric (and symbol-only) terms carry no topical signal.
  return tokens.some((token) => /\p{L}/u.test(token));
}

/**
 * Candidate keyword terms for one video: each whole normalized tag, plus
 * contiguous title n-grams of 2..4 tokens. Stopword-bearing, numeric-only, and
 * out-of-length terms are dropped; the result is deduped in first-seen order.
 */
export function extractTerms(input: {
  title: string;
  tags?: string[];
}): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (term: string, tokens: string[]) => {
    if (!isCandidateTerm(term, tokens) || seen.has(term)) return;
    seen.add(term);
    terms.push(term);
  };

  for (const tag of input.tags ?? []) {
    const term = normalizeKeyword(tag);
    if (term !== "") add(term, tokenize(term));
  }

  const tokens = tokenize(input.title);
  for (let start = 0; start < tokens.length; start += 1) {
    for (let size = MIN_NGRAM_LENGTH; size <= MAX_NGRAM_LENGTH; size += 1) {
      if (start + size > tokens.length) break;
      const slice = tokens.slice(start, start + size);
      add(slice.join(" "), slice);
    }
  }
  return terms;
}

export type ScoredTerm = {
  term: string;
  videoCount: number;
  medianOutlierScore: number;
  averageViews: number;
  exampleVideoIds: string[];
};

function byScoreDesc(a: ScoredTerm, b: ScoredTerm): number {
  if (a.medianOutlierScore !== b.medianOutlierScore) {
    return b.medianOutlierScore - a.medianOutlierScore;
  }
  if (a.videoCount !== b.videoCount) return b.videoCount - a.videoCount;
  return a.term.localeCompare(b.term);
}

/** Aggregate per-video terms into term scores. Terms must appear on at least
 *  two videos; example ids are the term's highest-outlier videos. Pure. */
export function scoreTerms(
  videos: {
    videoId: string;
    terms: string[];
    outlierScore: number;
    views: number | null;
  }[],
): ScoredTerm[] {
  const groups = new Map<
    string,
    {
      videoCount: number;
      outlierScores: number[];
      views: number[];
      examples: { videoId: string; outlierScore: number }[];
    }
  >();

  for (const video of videos) {
    for (const term of new Set(video.terms)) {
      const group = groups.get(term) ?? {
        videoCount: 0,
        outlierScores: [],
        views: [],
        examples: [],
      };
      group.videoCount += 1;
      group.outlierScores.push(video.outlierScore);
      group.views.push(video.views ?? 0);
      group.examples.push({
        videoId: video.videoId,
        outlierScore: video.outlierScore,
      });
      groups.set(term, group);
    }
  }

  const scored: ScoredTerm[] = [];
  for (const [term, group] of groups) {
    if (group.videoCount < MIN_VIDEOS_PER_TERM) continue;
    const exampleVideoIds = sort(
      group.examples,
      (a, b) => b.outlierScore - a.outlierScore,
    )
      .slice(0, MAX_EXAMPLE_VIDEO_IDS)
      .map((example) => example.videoId);
    scored.push({
      term,
      videoCount: group.videoCount,
      medianOutlierScore: round2(median(group.outlierScores)),
      averageViews: round2(
        group.views.reduce((sum, views) => sum + views, 0) / group.videoCount,
      ),
      exampleVideoIds,
    });
  }

  return sort(scored, byScoreDesc);
}

/** Competitor terms the owned channel does not cover. Both sides are compared
 *  normalized, so casing/spacing never hides a gap. Pure. */
export function rankGaps(
  you: ScoredTerm[],
  competitor: ScoredTerm[],
  minVideoCount: number,
): ScoredTerm[] {
  const owned = new Set(you.map((term) => normalizeKeyword(term.term)));
  return sort(
    competitor.filter(
      (term) =>
        term.videoCount >= minVideoCount &&
        !owned.has(normalizeKeyword(term.term)),
    ),
    byScoreDesc,
  );
}
