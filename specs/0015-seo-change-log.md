# SEO change log (changes with before/after measurement)

## Status

Proposed.

## What it does

- A project keeps a log of changes shipped to its site. Each change has a ship time and time zone, a type (title/meta, content, internal links, schema, redirect/canonical, technical/performance, other), one or more affected pages, optional target queries, a short summary, optional before/after title and meta description, references (commit, deploy ID, PR link), an author, and notes.
- Pages are full URLs or paths. A `*` matches a whole template, so `/tools/*` covers every tool page.
- When a change is logged, OpenSEO stores Search Console clicks, impressions, CTR and average position for each page and query over the 28 days before the ship day, overall and by device. That stored baseline is what later results are compared against.
- 14 and 28 days after the ship day, OpenSEO measures the same targets over the window after the change and shows per-day deltas next to the baseline. Every result carries the whole site's change over the same window and flags likely noise: `low_volume` when either window has too few impressions, and `matches_site_trend` when a page moved the same way and by about as much as the site.
- A change can be marked reverted. Measurements whose window had not closed by the revert are skipped, since they would mix both versions.
- Each logged change is a marker on the Search Console trend chart (GSC Insights) and the GA4 organic sessions chart on the dashboard.
- Four free MCP tools: `log_change`, `list_changes` (filter by page, type, ship-date range), `get_change_impact`, `update_change` (notes, revert, references). `get_project_context` lists changes from the last 90 days, so an agent starting SEO work sees what was just changed.

## How it works

**Data.** Four tables, all under the project cascade:

- `seo_changes`: one row per change, with the ship instant (UTC), the author's time zone, and the ship date in that zone. Every window is anchored to the ship date, and date filters and chart markers use it too.
- `seo_change_targets`: one row per page, page pattern or query.
- `seo_change_checkpoints`: `baseline`, `day_14` and `day_28`, each with its window, the time it is due, and a status (`pending`, `measured`, `failed`, `skipped`).
- `seo_change_metrics`: totals per checkpoint, target and device. A null target is the whole site.

Targets and measurements are rows rather than JSON on the change, so a URL filter, a per-device read and a site comparison are plain queries.

**Windows.** The ship day belongs to neither side. The baseline is the 28 days before it, taken as soon as the change is logged. Search Console data trails by about three days, so a change logged on the day it ships would otherwise wait. Instead the baseline slides back to the last settled day and keeps its 28-day length. The post-change windows are days 1–14 and 1–28 after the ship day. Each is due three days after it closes. Clicks and impressions are compared as per-day rates so that a 14-day window compares fairly with the 28-day baseline, and both lengths are whole weeks, so weekday mix doesn't skew the comparison.

**Matching.** A full URL matches Search Console's page dimension exactly. A path matches on any protocol and host, so `/pricing` finds the page on both apex and `www` properties. `*` becomes a regular-expression wildcard. Queries match exactly, site-wide.

**Measuring.** The 5-minute cron picks up pending checkpoints that are due, claims each with a compare-and-swap on its attempt count, and stores all its metric rows plus the status change in one batch. `get_change_impact` also measures any due checkpoint it finds, so results arrive even where no cron runs. A failure is recorded on the checkpoint and retried daily for two weeks. That covers a Search Console connection that was missing or expired when the change was logged.

**Invariants.**

- A stored measurement is never recomputed: later Search Console revisions and the 16-month retention cutoff cannot change the numbers a change was judged on.
- Every read and write is scoped by project id; a change id from another project reads as not found.
- The ship date and targets are fixed once logged. A different change is logged as a new change.

Change logging is counted in telemetry. Erasing a user re-attributes the changes they logged.

## Alternatives considered

- Keeping the log in a saved report or in project context: it can't hold a measured baseline, so someone still has to pull data 4 weeks later and compare by hand.
- Computing results live from Search Console on every read instead of storing snapshots: data older than 16 months disappears, and a read months later would disagree with the one taken at the time.
- Taking the baseline only once the full pre-ship window has settled: more exact, but it leaves the "before" numbers unrecorded for days, which is what the feature exists to prevent.
- Comparing raw window totals: a 14-day window against a 28-day baseline would always read as a 50% drop. Per-day rates fix that.
- A statistical significance test instead of the two noise flags: daily Search Console data is autocorrelated and seasonal, and a p-value would claim more precision than the data supports. The site comparison answers the question people actually have: did this page move, or did everything move?
- A Workflow or queue per checkpoint: measurements cost a handful of free Search Console calls, and three checkpoints per change make the cron's due-query nearly always empty.

## Not in scope

- Measuring GA4 metrics per change. Charts show the markers; the measured deltas are Search Console only.
- Automatically detecting changes from deploys or crawls.
- Custom checkpoint schedules beyond +14 and +28 days.
