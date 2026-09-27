# Sitemap-wide PageSpeed

## Status

Proposed.

## What it does

Each weekly audit also queues a PageSpeed sweep: every same-origin URL in the site's sitemaps (robots.txt entries plus `/sitemap.xml`, up to 50,000) gets one mobile PageSpeed Insights run. The results appear in three places:

- the PageSpeed page in the sidebar
- a dashboard card
- the `get_pagespeed_report` MCP tool

`run_pagespeed_sweep` and the page's "Run now" button queue an extra sweep on demand.

On hosted OpenSEO, sweeps need a paid plan because every tenant shares one PageSpeed Insights API key; self-hosted instances run them without restriction.

## How it works

**Data.**

- `pagespeed_sweeps` holds one row per sweep.
- `pagespeed_results` holds one row per sweep and URL: scores, lab metrics and CrUX field data.
- `pagespeed_result_issues` holds the ten costliest failing audits per page, so problems can be grouped across the site.
- `pagespeed_usage` counts calls per Google quota day.

The two most recent completed sweeps per project are kept for a week-over-week comparison.

**Pacing.** One API key serves every project, so sweeps share its quota:

- At most three sweeps are active at once, counting any paused for the daily quota, so a quota reset never relaunches a backlog all at once.
- Each tests 24 URLs per workflow step, four at a time, under its share of a 200-per-minute budget.
- A partial unique index allows one active sweep per project.
- Daily use is reserved up front against a 24,000 budget (Google allows 25,000); reservations a rate limit left unused are returned.

A per-minute 429 backs off and leaves the page pending. A daily-quota 429 pauses the sweep until midnight Pacific, when the cron relaunches it. A page PageSpeed can't test is stored as failed and never blocks the rest. Progress lives on the result rows, so a retried step or relaunched workflow continues where it stopped.

## Alternatives considered

- **The audit's Lighthouse phase.** That phase samples ten crawled pages and stores results against crawled page rows, and the crawl only sees as many sitemap URLs as its page budget allows. A sitemap-wide run needs its own URL set and a resumable, quota-paced loop, the same shape as the Search Console index sweep.
- **A per-organization share of the daily quota.** Fairer when many paid organizations sweep large sites, but first-come order under a small concurrency cap is enough at current scale.
