# Search Console coverage (indexing, sitemaps, Core Web Vitals)

## Status

Proposed.

## What it does

- **Indexing.** Rebuilds Search Console's Page indexing report. Every URL in the property's sitemaps, plus every page with search impressions in the last 16 months, is inspected with the URL Inspection API. Results are grouped by Google's own reason ("Crawled - currently not indexed", "Duplicate, Google chose different canonical than user", "Not found (404)", ...) under indexed, not indexed, inspection failed, and not yet inspected. Each reason counts the URLs that entered it since the previous sweep, so new issues stand out. Each inspection also stores the live page's `<title>`, meta description, and HTTP status.
- **Enhancements.** The same inspections carry Google's rich result detection. Issues are grouped by rich result type and message, with severity and the pages affected.
- **Sitemaps.** Every submitted sitemap, the children of each sitemap index, and each one's error and warning counts and submitted URL counts.
- **Search Analytics.** Every search type, dimension (including `hour` and `searchAppearance`), aggregation type, data state, and filter group Google supports. Callers page through all rows with a cursor.
- **Core Web Vitals.** Chrome UX Report field data per origin or for the top pages by impressions, on phone and desktop, rated against Google's thresholds. It is labelled as CrUX data because Search Console's own report has no API.
- **Health summary.** `get_search_console_health` puts all of the above in one response for an agent, along with the page-level click and impression drops (last 28 days against the previous 28). It also names the Search Console reports that have no API at all: manual actions, security issues, links, crawl stats, and removals.
- The app has an Indexing page with summary cards, sweep progress and quota, a reasons table that opens the URL list, a URL detail drawer, rich result issues, and a sitemaps table. A Core Web Vitals panel sits on the Search Performance page.
- MCP tools: `get_search_console_health`, `list_gsc_properties`, `get_sitemaps`, `get_index_coverage`, `list_index_issues`, `list_indexed_urls`, `get_rich_result_issues`, `start_index_sweep`, `get_core_web_vitals`. `submit_sitemap` and `delete_sitemap` are listed only when the user's grant has write access. `inspect_urls` stays a live, uncached call.

## How it works

**Data.** All rows sit under the project cascade:

- `gsc_sitemaps` and `gsc_sitemap_contents` hold the latest `sitemaps.list` snapshot, replaced whole on refresh.
- `gsc_index_urls` holds the URL set and its queue state: sitemap and Search Analytics membership, impressions, when it was last inspected, a pointer to its latest inspection, and when it entered its current reason.
- `gsc_url_inspections` holds one row per inspection attempt. Sitemap and referring URLs go in `gsc_url_inspection_links`, and rich result items and issues in `gsc_url_rich_result_issues`. A failed attempt keeps its error and does not replace the URL's last good result.
- `gsc_index_sweeps` holds one row per sweep. A partial unique index allows only one active sweep per project.
- `gsc_inspection_usage` counts inspections per property per Pacific-time day. It is keyed by property, not project, because Google meters the property.

**Sweeps.** A workflow first collects the URL set, then inspects batches of 50 URLs, four at a time. Queue order is explicitly requested URLs, then URLs never inspected, then the stalest results, with impressions breaking ties. A sweep is finished when every URL has a result newer than the sweep's start. Progress lives on the URL rows, so a retried step, a quota pause, or a relaunched workflow simply runs the same query again and continues.

**Quota.** Google allows 2,000 inspections per property per day and 600 per minute. Each batch reserves its URLs against the day's count before calling Google. When the day is spent, whether by our count or by Google answering with a daily-quota error, the sweep pauses until midnight Pacific. A sliding one-minute window keeps batches under 500 per minute, which leaves room when two projects share a property. Per-minute 429s and 5xx responses are retried with backoff, while daily-quota errors are not retried.

**Scheduling.** An hourly cron trigger resumes paused sweeps once the quota day rolls over, relaunches sweeps whose workflow instance is gone or that have gone 15 minutes without an inspection, and starts a full sweep for any connected project whose last sweep began over a day ago. The Docker image fires that one trigger itself every 15 minutes, since `vite preview` runs no crons. "Run now" and `start_index_sweep` start a sweep immediately. Requested URLs join a running sweep at the front of its queue.

**Write access.** The default grant is `webmasters.readonly`. Enabling sitemap management re-consents with `webmasters`. Grants store their scopes, and the MCP server lists the write tools only when one of the user's grants has that scope. The tools also check the project's own connection before writing.

## Alternatives considered

- **Scraping the Search Console web UI** for the real Page indexing, Core Web Vitals, and manual actions reports. Rejected: it is unsupported and breaks without warning.
- **Latest results as columns on the URL row.** Rejected in favour of a pointer to the latest inspection row. History stays complete and the result fields live in one place.
- **Keeping one workflow sleeping across days.** Workflows have a step budget. A long sweep yields back to the cron instead, which also recovers sweeps whose instance died.
- **Titles from Google.** No Search Console API returns the title Google shows in results, so the page's own `<title>` is stored and labelled as such.
