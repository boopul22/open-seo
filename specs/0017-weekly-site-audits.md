# Weekly site audits

## Status

Proposed.

## What it does

- A project can turn on an automatic weekly site audit. OpenSEO crawls the site once every 7 days with the same crawler and issue checks as a manual audit, without Lighthouse.
- Each run respects the account's audit limits: the page budget is capped at the plan's per-audit maximum, and a run that a limit refuses (capacity, concurrent audits, no subscription) is skipped and the reason recorded.
- The two most recent scheduled audits are kept. Before each new run the one before last is deleted, so a schedule never grows the account's audit capacity. Audits started by hand are never deleted.
- MCP tools: `schedule_site_audit` turns the schedule on, changes its URL or page budget, or turns it off. `get_scheduled_audit_report` returns the schedule state, the latest finished crawl's issue counts by type and severity, and what changed since the previous crawl: new issues with their pages, resolved issues, and issue types that got worse. `get_project_context` mentions the schedule so an agent knows the report exists.

## How it works

**Data.** `audit_schedules` holds one row per project (unique on `project_id`, cascading with the project). It stores the start URL, page budget, the user whose identity starts the audits, `next_run_at`, `last_run_at`, the last skip reason, and pointers to the last and previous scheduled audits. The pointers are set to null if an audit is deleted by other means.

**Running.** The hourly cron trigger (the same one that runs Search Console index sweeps, which self-hosted Docker also fires) starts up to five due schedules per tick. For each one it:

1. Waits if last week's crawl is still running, retrying on the next tick.
2. Claims the row by moving `next_run_at` forward 7 days with a compare-and-set, so overlapping ticks can't start two crawls.
3. Resolves the plan tier, deletes the audit before last, and starts the crawl through the normal audit service, which enforces the plan limits.
4. Shifts the pointers (last becomes previous, the new audit becomes last), or records why the week was skipped.
5. On a paid or self-hosted plan, queues a sitemap-wide PageSpeed sweep (see 0018).

**Diff.** The report compares issue rows by (issue type, page URL) between the last two completed scheduled crawls. While this week's crawl runs, it reports last week's without a diff.

## Alternatives considered

- **Keeping every scheduled audit.** It gives full history, but each audit counts against the account's cumulative audit capacity, so a free account would stop running audits after a few weeks. Two audits are enough for a week-over-week diff.
- **The five-minute cron.** Self-hosted Docker only fires the hourly trigger, so weekly audits would never run there.
- **Reusing rank-tracking schedules.** Those are keyword-check configurations with their own intervals and billing rules; an audit schedule shares none of their fields.
