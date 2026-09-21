/* eslint-disable max-lines -- one keywords tab keeps its five research sections colocated (YoutubeVideosPage precedent). */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { CardShell, Stat } from "@/client/features/dashboard/cardParts";
import { formatCount } from "@/client/features/search-performance/SearchPerformanceColumns";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { formatRelativeTime } from "@/client/lib/relative-time";
import {
  compareYoutubeKeywords,
  getYoutubeHighPerformanceKeywords,
  getYoutubeKeywordGap,
  getYoutubeKeywordIdeas,
  getYoutubeKeywordPerformance,
  type HighPerformanceKeywords,
  type KeywordComparison,
  type KeywordGap,
  type KeywordIdeas,
  type KeywordIdeaSource,
  type KeywordPerformance,
} from "@/serverFunctions/youtubeKeywords";
import { listYoutubeResearchChannels } from "@/serverFunctions/youtubeResearch";

// The YouTube search sample defaults to US on the server; the client pins the
// same region so query keys name the market they hold.
const REGION_CODE = "US";
const DEFAULT_MIN_VIDEOS = 2;
const MIN_VIDEOS_OPTIONS = [2, 3, 5];
const COMPARE_MIN_KEYWORDS = 2;
const COMPARE_MAX_KEYWORDS = 5;
const KEYWORD_LIMIT = 25;

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const IDEA_SOURCE_LABELS: Record<KeywordIdeaSource, string> = {
  autocomplete: "Autocomplete",
  tag: "Tag",
  title: "Title",
};

const IDEA_SOURCE_TONES: Record<KeywordIdeaSource, string> = {
  autocomplete: "badge-primary",
  tag: "badge-secondary",
  title: "badge-ghost",
};

// The service reports raw warning codes; these are the two it currently emits.
const IDEA_WARNING_TEXT: Record<string, string> = {
  autocomplete_unavailable:
    "Autocomplete suggestions were unavailable; these ideas come from video tags and titles.",
  search_unavailable:
    "Video tags and titles could not be sampled; these ideas come from autocomplete only.",
};

type OwnedChannel = { channelId: string | null; channelTitle: string | null };
type ScoredTerm = HighPerformanceKeywords["keywords"][number];

function SectionSkeleton() {
  return (
    <div aria-busy className="space-y-2">
      <div className="skeleton h-8" />
      <div className="skeleton h-8" />
      <div className="skeleton h-8" />
    </div>
  );
}

function SectionError({ error }: { error: unknown }) {
  return (
    <p role="alert" className="text-sm text-error">
      {getStandardErrorMessage(error)}
    </p>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="py-4 text-sm text-base-content/60">{children}</p>;
}

function MutedNote({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-base-content/50">{children}</p>;
}

function ScoreBadge({ score }: { score: number }) {
  const tone =
    score >= 5 ? "badge-error" : score >= 2 ? "badge-warning" : "badge-ghost";
  return (
    <span className={`badge badge-sm tabular-nums ${tone}`}>
      {score.toFixed(1)}x
    </span>
  );
}

function ScoredTermTable({
  terms,
  emptyMessage,
  showExamples = false,
}: {
  terms: ScoredTerm[];
  emptyMessage: string;
  showExamples?: boolean;
}) {
  if (terms.length === 0) return <EmptyNote>{emptyMessage}</EmptyNote>;
  return (
    <div className="overflow-x-auto rounded-lg border border-base-300">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Term</th>
            <th className="text-right">Videos</th>
            <th className="text-right">Median score</th>
            <th className="text-right">Avg views</th>
            {showExamples ? <th>Examples</th> : null}
          </tr>
        </thead>
        <tbody>
          {terms.map((term) => (
            <tr key={term.term}>
              <td className="font-medium">{term.term}</td>
              <td className="text-right tabular-nums">{term.videoCount}</td>
              <td className="text-right">
                <ScoreBadge score={term.medianOutlierScore} />
              </td>
              <td className="text-right tabular-nums">
                {compact.format(term.averageViews)}
              </td>
              {showExamples ? (
                <td className="whitespace-nowrap">
                  <span className="flex gap-1.5">
                    {term.exampleVideoIds.map((videoId, index) => (
                      <a
                        key={videoId}
                        href={`https://youtube.com/watch?v=${videoId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="link link-hover text-xs"
                        title={videoId}
                        aria-label={`Example video ${index + 1} for ${term.term}`}
                      >
                        {index + 1}
                      </a>
                    ))}
                  </span>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MinVideosSelect({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
}) {
  return (
    <select
      className="select select-bordered select-sm w-36"
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      aria-label={label}
    >
      {MIN_VIDEOS_OPTIONS.map((option) => (
        <option key={option} value={option}>
          {option}+ videos
        </option>
      ))}
    </select>
  );
}

/**
 * On-demand read for one section: the query is disabled so typing never
 * fetches. `run(value)` commits the submitted value, which changes the query
 * key and refetches; re-submitting the same value refetches directly.
 */
function useOnDemandQuery<T>(
  buildKey: (committed: string) => readonly unknown[],
  buildQueryFn: (committed: string) => () => Promise<T>,
) {
  const [committed, setCommitted] = React.useState<string | null>(null);
  const query = useQuery({
    queryKey: buildKey(committed ?? ""),
    queryFn: buildQueryFn(committed ?? ""),
    enabled: false,
  });
  React.useEffect(() => {
    if (committed === null) return;
    void query.refetch();
    // Refetch follows committed-parameter changes; the submit handler refetches
    // directly when the same value is submitted again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed]);
  const run = (value: string) => {
    if (value === committed) void query.refetch();
    else setCommitted(value);
  };
  return { query, run, committed };
}

function KeywordIdeasSection({ projectId }: { projectId: string }) {
  const [seed, setSeed] = React.useState("");
  const { query, run, committed } = useOnDemandQuery<KeywordIdeas>(
    (value) => ["youtubeKeywordIdeas", projectId, value],
    (value) => () =>
      getYoutubeKeywordIdeas({ data: { projectId, seed: value } }),
  );
  const data = query.data;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = seed.trim();
    if (value === "" || query.isFetching) return;
    run(value);
  };

  return (
    <CardShell title="Keyword ideas">
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={seed}
          onChange={(event) => setSeed(event.target.value)}
          placeholder="e.g. minecraft survival"
          aria-label="Keyword seed"
          className="input input-bordered input-sm w-full"
        />
        <button
          type="submit"
          className="btn btn-primary btn-sm shrink-0"
          disabled={seed.trim() === "" || query.isFetching}
        >
          {query.isFetching ? (
            <Loader2 className="size-4 animate-spin" />
          ) : null}
          Find ideas
        </button>
      </form>

      <div className="mt-4 space-y-3">
        {query.isError ? (
          <SectionError error={query.error} />
        ) : data ? (
          data.ideas.length === 0 ? (
            <EmptyNote>
              No keyword ideas found for &ldquo;{data.seed}&rdquo;.
            </EmptyNote>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-base-300">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th className="w-12">#</th>
                    <th>Phrase</th>
                    <th className="w-32">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ideas.map((idea) => (
                    <tr key={`${idea.position}-${idea.phrase}`}>
                      <td className="tabular-nums text-base-content/50">
                        {idea.position + 1}
                      </td>
                      <td className="font-medium">{idea.phrase}</td>
                      <td>
                        <span
                          className={`badge badge-sm ${IDEA_SOURCE_TONES[idea.source]}`}
                        >
                          {IDEA_SOURCE_LABELS[idea.source]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : committed !== null ? (
          <SectionSkeleton />
        ) : (
          <EmptyNote>
            Enter a seed keyword to collect autocomplete, tag, and title
            phrases.
          </EmptyNote>
        )}
        {data && data.warnings.length > 0 ? (
          <ul className="space-y-1">
            {data.warnings.map((warning) => (
              <li key={warning} className="text-xs text-base-content/50">
                {IDEA_WARNING_TEXT[warning] ?? warning}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </CardShell>
  );
}

function KeywordPerformanceSection({ projectId }: { projectId: string }) {
  const [keyword, setKeyword] = React.useState("");
  const [force, setForce] = React.useState(false);
  const { query, run, committed } = useOnDemandQuery<KeywordPerformance>(
    (value) => ["youtubeKeywordPerformance", projectId, value, REGION_CODE],
    (value) => () =>
      getYoutubeKeywordPerformance({
        data: {
          projectId,
          keyword: value,
          regionCode: REGION_CODE,
          ...(force ? { force: true } : {}),
        },
      }),
  );
  const data = query.data;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = keyword.trim();
    if (value === "" || query.isFetching) return;
    run(value);
  };

  return (
    <CardShell title="Keyword performance">
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="e.g. minecraft survival"
          aria-label="Keyword to analyze"
          className="input input-bordered input-sm w-full"
        />
        <button
          type="submit"
          className="btn btn-primary btn-sm shrink-0"
          disabled={keyword.trim() === "" || query.isFetching}
        >
          {query.isFetching ? (
            <Loader2 className="size-4 animate-spin" />
          ) : null}
          Analyze
        </button>
        <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm">
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={force}
            onChange={(event) => setForce(event.target.checked)}
          />
          Force refresh
        </label>
      </form>
      <div className="mt-2">
        <MutedNote>
          Uncached analyses use 100 YouTube quota units; results are cached 24h.
        </MutedNote>
      </div>

      <div className="mt-4 space-y-3">
        {query.isError ? (
          <SectionError error={query.error} />
        ) : data ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat
                label="Median views"
                value={formatCount(data.medianViews)}
              />
              <Stat
                label="Average views"
                value={formatCount(data.averageViews)}
              />
              <Stat
                label="Median views/day"
                value={compact.format(data.medianViewsPerDay)}
              />
              <Stat label="Sample size" value={String(data.sampleSize)} />
              <Stat
                label="Captured"
                value={formatRelativeTime(data.capturedAt) || "—"}
              />
            </div>
            <div className="overflow-x-auto rounded-lg border border-base-300">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th className="w-12">#</th>
                    <th>Video</th>
                    <th>Channel</th>
                    <th className="text-right">Views</th>
                    <th className="text-right">Views/day</th>
                  </tr>
                </thead>
                <tbody>
                  {data.videos.map((video) => (
                    <tr key={video.videoId}>
                      <td className="tabular-nums text-base-content/50">
                        {video.position + 1}
                      </td>
                      <td className="max-w-sm">
                        <a
                          href={`https://youtube.com/watch?v=${video.videoId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="link link-hover line-clamp-2 font-medium"
                          title={video.title}
                        >
                          {video.title}
                        </a>
                      </td>
                      <td className="whitespace-nowrap text-sm text-base-content/70">
                        {video.channelTitle || "—"}
                      </td>
                      <td className="text-right tabular-nums">
                        {video.views === null ? "—" : formatCount(video.views)}
                      </td>
                      <td className="text-right tabular-nums">
                        {compact.format(Math.round(video.viewsPerDay))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : committed !== null ? (
          <SectionSkeleton />
        ) : (
          <EmptyNote>
            Analyze a keyword to sample its top result videos and their views.
          </EmptyNote>
        )}
      </div>
    </CardShell>
  );
}

function HighPerformanceKeywordsSection({
  projectId,
  ownedChannel,
}: {
  projectId: string;
  ownedChannel: OwnedChannel;
}) {
  const [scope, setScope] = React.useState("");
  const [minVideos, setMinVideos] = React.useState(DEFAULT_MIN_VIDEOS);
  const channelsQuery = useQuery({
    queryKey: ["youtubeResearchChannels", projectId],
    queryFn: () => listYoutubeResearchChannels({ data: { projectId } }),
  });
  const researchChannels = (channelsQuery.data?.channels ?? []).filter(
    (channel) => channel.channelId !== ownedChannel.channelId,
  );
  const { query, run, committed } = useOnDemandQuery<HighPerformanceKeywords>(
    (value) => [
      "youtubeHighPerformanceKeywords",
      projectId,
      value === "" ? null : value,
    ],
    (value) => () =>
      getYoutubeHighPerformanceKeywords({
        data: {
          projectId,
          ...(value ? { channelId: value } : {}),
          minVideos,
          limit: KEYWORD_LIMIT,
        },
      }),
  );
  const data = query.data;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (query.isFetching) return;
    run(scope);
  };

  return (
    <CardShell title="High-performance keywords">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <select
          className="select select-bordered select-sm w-64"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
          aria-label="Channel to score"
        >
          <option value="">
            My channel
            {ownedChannel.channelTitle ? ` · ${ownedChannel.channelTitle}` : ""}
          </option>
          {researchChannels.map((channel) => (
            <option key={channel.channelId} value={channel.channelId}>
              {channel.channelTitle}
            </option>
          ))}
        </select>
        <MinVideosSelect
          value={minVideos}
          onChange={setMinVideos}
          label="Minimum videos per term"
        />
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={query.isFetching}
        >
          {query.isFetching ? (
            <Loader2 className="size-4 animate-spin" />
          ) : null}
          Find keywords
        </button>
      </form>

      <div className="mt-4 space-y-3">
        {query.isError ? (
          <SectionError error={query.error} />
        ) : data ? (
          <>
            <MutedNote>
              Terms on at least {minVideos} of {data.channel.channelTitle}
              &rsquo;s most recent uploads.
            </MutedNote>
            <ScoredTermTable
              terms={data.keywords}
              emptyMessage={`No terms appeared on ${minVideos}+ sampled videos.`}
              showExamples
            />
          </>
        ) : committed !== null ? (
          <SectionSkeleton />
        ) : (
          <EmptyNote>
            Score the channel&rsquo;s newest uploads into ranked terms.
          </EmptyNote>
        )}
      </div>
    </CardShell>
  );
}

function KeywordGapSection({ projectId }: { projectId: string }) {
  const [competitor, setCompetitor] = React.useState("");
  const [minVideos, setMinVideos] = React.useState(DEFAULT_MIN_VIDEOS);
  const { query, run, committed } = useOnDemandQuery<KeywordGap>(
    (value) => ["youtubeKeywordGap", projectId, value],
    (value) => () =>
      getYoutubeKeywordGap({
        data: {
          projectId,
          competitorChannel: value,
          minVideos,
          limit: KEYWORD_LIMIT,
        },
      }),
  );
  const data = query.data;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = competitor.trim();
    if (value === "" || query.isFetching) return;
    run(value);
  };

  return (
    <CardShell title="Keyword gap">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={competitor}
          onChange={(event) => setCompetitor(event.target.value)}
          placeholder="youtube.com/@handle, @handle, or UC… channel ID"
          aria-label="Competitor channel"
          className="input input-bordered input-sm w-full sm:w-80"
        />
        <MinVideosSelect
          value={minVideos}
          onChange={setMinVideos}
          label="Minimum videos per term"
        />
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={competitor.trim() === "" || query.isFetching}
        >
          {query.isFetching ? (
            <Loader2 className="size-4 animate-spin" />
          ) : null}
          Find gaps
        </button>
      </form>

      <div className="mt-4 space-y-3">
        {query.isError ? (
          <SectionError error={query.error} />
        ) : data ? (
          <>
            <MutedNote>
              Compared with {data.competitorChannel.channelTitle} ·{" "}
              {data.you.length} of your terms vs {data.competitor.length}{" "}
              competitor terms.
            </MutedNote>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Your top terms</h3>
                <ScoredTermTable
                  terms={data.you}
                  emptyMessage="None of your terms passed the video minimum."
                />
              </div>
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Gaps to target</h3>
                <ScoredTermTable
                  terms={data.gaps}
                  emptyMessage="No gaps found — you already cover this competitor's top terms."
                />
              </div>
            </div>
          </>
        ) : committed !== null ? (
          <SectionSkeleton />
        ) : (
          <EmptyNote>
            Compare a competitor&rsquo;s top terms with yours to find gaps.
          </EmptyNote>
        )}
      </div>
    </CardShell>
  );
}

function parseKeywords(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((part) => part.trim())
        .filter((part) => part !== ""),
    ),
  ];
}

function KeywordCompareSection({ projectId }: { projectId: string }) {
  const [input, setInput] = React.useState("");
  const { query, run, committed } = useOnDemandQuery<KeywordComparison>(
    (value) => ["youtubeKeywordCompare", projectId, value],
    (value) => () =>
      compareYoutubeKeywords({
        data: {
          projectId,
          keywords: value.split(","),
          regionCode: REGION_CODE,
        },
      }),
  );
  const parsed = parseKeywords(input);
  const countValid =
    parsed.length >= COMPARE_MIN_KEYWORDS &&
    parsed.length <= COMPARE_MAX_KEYWORDS;
  const data = query.data;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!countValid || query.isFetching) return;
    run(parsed.join(","));
  };

  return (
    <CardShell title="Compare keywords">
      <form onSubmit={submit} className="flex flex-col gap-2">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          rows={3}
          placeholder={"minecraft survival, minecraft house\nminecraft mods"}
          aria-label="Keywords to compare"
          className="textarea textarea-bordered textarea-sm w-full"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={!countValid || query.isFetching}
          >
            {query.isFetching ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            Compare
          </button>
          {parsed.length > 0 && !countValid ? (
            <p className="text-xs text-warning">
              Enter between {COMPARE_MIN_KEYWORDS} and {COMPARE_MAX_KEYWORDS}{" "}
              keywords, separated by commas or new lines.
            </p>
          ) : (
            <MutedNote>
              Enter {COMPARE_MIN_KEYWORDS}–{COMPARE_MAX_KEYWORDS} keywords
              separated by commas or new lines.
            </MutedNote>
          )}
        </div>
      </form>

      <div className="mt-4 space-y-3">
        {query.isError ? (
          <SectionError error={query.error} />
        ) : data ? (
          data.rows.length === 0 ? (
            <EmptyNote>No comparison rows returned.</EmptyNote>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-base-300">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>Keyword</th>
                    <th className="text-right">Median views</th>
                    <th className="text-right">Median views/day</th>
                    <th className="text-right">Sample size</th>
                    <th>Cached</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, index) =>
                    "error" in row ? (
                      <tr key={`${row.keyword}-${index}`}>
                        <td className="font-medium">{row.keyword || "—"}</td>
                        <td
                          colSpan={4}
                          className={
                            row.error === "no_results"
                              ? "text-sm text-base-content/60"
                              : "text-sm text-error"
                          }
                        >
                          {row.error === "no_results"
                            ? "No results"
                            : "Unavailable"}
                        </td>
                      </tr>
                    ) : (
                      <tr key={`${row.keyword}-${index}`}>
                        <td className="font-medium">{row.keyword}</td>
                        <td className="text-right tabular-nums">
                          {formatCount(row.medianViews)}
                        </td>
                        <td className="text-right tabular-nums">
                          {compact.format(row.medianViewsPerDay)}
                        </td>
                        <td className="text-right tabular-nums">
                          {row.sampleSize}
                        </td>
                        <td>
                          {row.cached ? (
                            <span className="badge badge-sm badge-ghost">
                              Cached
                            </span>
                          ) : (
                            <span className="badge badge-sm badge-info">
                              Fresh
                            </span>
                          )}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )
        ) : committed !== null ? (
          <SectionSkeleton />
        ) : (
          <EmptyNote>
            Compare cached search samples to see which keyword pulls the most
            views.
          </EmptyNote>
        )}
      </div>
    </CardShell>
  );
}

/** Keyword research for the project: ideas, cached performance samples,
 *  channel term scoring, competitor gaps, and side-by-side comparisons. */
export function YoutubeKeywordsTab({
  projectId,
  ownedChannel,
}: {
  projectId: string;
  ownedChannel: OwnedChannel;
}) {
  return (
    <div className="space-y-4">
      <KeywordIdeasSection projectId={projectId} />
      <KeywordPerformanceSection projectId={projectId} />
      <HighPerformanceKeywordsSection
        projectId={projectId}
        ownedChannel={ownedChannel}
      />
      <KeywordGapSection projectId={projectId} />
      <KeywordCompareSection projectId={projectId} />
    </div>
  );
}
