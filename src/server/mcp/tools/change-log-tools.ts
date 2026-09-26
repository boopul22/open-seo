import { z } from "zod";
import { SeoChangeService } from "@/server/features/seo-changes/services/SeoChangeService";
import { captureServerEvent } from "@/server/lib/posthog";
import { DEFAULT_CLIENT_LABEL } from "@/server/mcp/client-label";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { buildDashboardUrl } from "@/server/mcp/urls";
import { SEO_CHANGE_TYPE_LABELS } from "@/shared/seo-changes";
import {
  seoChangeInputSchema,
  seoChangeListFiltersSchema,
  seoChangeUpdateSchema,
  type SeoChange,
  type SeoChangeCheckpointSummary,
  type SeoChangeImpact,
} from "@/types/schemas/seoChanges";

// Change log tools use only the app DB and the project's Search Console
// connection; none of them spend credits.

const changesPath = (projectId: string) => `/p/${projectId}/changes`;

const changeIdSchema = z
  .string()
  .min(1)
  .describe("Change id from list_changes or log_change.");

function changeLine(change: SeoChange): string {
  const targets = change.targets.map((t) =>
    t.kind === "query" ? `"${t.value}"` : t.value,
  );
  return [
    `${change.id}  ${change.shipDate}  [${SEO_CHANGE_TYPE_LABELS[change.type]}]${
      change.status === "reverted"
        ? ` REVERTED ${change.revertedAt?.slice(0, 10) ?? ""}`
        : ""
    }`,
    `  ${change.summary}`,
    `  targets: ${targets.join(", ")} · by ${change.author}`,
  ].join("\n");
}

function checkpointLine(checkpoint: SeoChangeCheckpointSummary): string {
  const window = `${checkpoint.windowStart}..${checkpoint.windowEnd}`;
  const status =
    checkpoint.status === "pending"
      ? `pending, due ${checkpoint.dueAt.slice(0, 10)}`
      : checkpoint.status;
  return `- ${checkpoint.kind} (${window}): ${status}${
    checkpoint.error ? ` — ${checkpoint.error}` : ""
  }`;
}

const signed = (value: number, digits: number) =>
  `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;

function pct(value: number | null): string {
  return value === null ? "new" : `${signed(value, 0)}%`;
}

function renderImpactText(impact: SeoChangeImpact): string {
  const lines = [
    changeLine(impact.change),
    "",
    "Checkpoints:",
    ...impact.checkpoints.map(checkpointLine),
  ];

  if (impact.results.length === 0) {
    lines.push(
      "",
      "No post-change window has been measured yet. Clicks and impressions are compared per day; the baseline is the 28 days before the ship date.",
    );
  }

  for (const result of impact.results) {
    lines.push(
      "",
      `## ${result.kind} (${result.windowStart}..${result.windowEnd}) vs baseline — all devices, per day`,
      "target | clicks/day | impressions/day | CTR | position | vs site | noise",
    );
    for (const row of result.targets) {
      const all = row.deltas.find((delta) => delta.device === "all");
      if (!all) continue;
      lines.push(
        [
          row.target ? row.target.value : "(whole site)",
          `${all.clicksPerDay.before.toFixed(1)} → ${all.clicksPerDay.after.toFixed(1)} (${pct(all.clicksPerDay.changePct)})`,
          `${all.impressionsPerDay.before.toFixed(0)} → ${all.impressionsPerDay.after.toFixed(0)} (${pct(all.impressionsPerDay.changePct)})`,
          `${(all.ctr.before * 100).toFixed(1)}% → ${(all.ctr.after * 100).toFixed(1)}% (${signed(all.ctr.change * 100, 1)} pts)`,
          `${all.position.before.toFixed(1)} → ${all.position.after.toFixed(1)} (${signed(all.position.change, 1)})`,
          row.clicksVsSitePts === null
            ? "—"
            : `${signed(row.clicksVsSitePts, 0)} pts`,
          row.target === null ? "—" : row.noise.join(", ") || "none",
        ].join(" | "),
      );
    }
  }
  if (impact.results.length > 0) {
    lines.push(
      "",
      "Per-device deltas are in structuredContent. Treat low_volume and matches_site_trend rows as noise, not as the change's effect.",
    );
  }
  return lines.join("\n");
}

// ----------------------------------------------------------------- log_change

const logInputSchema = {
  projectId: projectIdSchema,
  ...seoChangeInputSchema.shape,
} as const;

const logOutputSchema = z.looseObject({
  changeId: z.string(),
  change: looseObjectOutputSchema,
  baseline: looseObjectOutputSchema,
  url: z.string(),
  ...optionalMetaOutputSchema,
});

export const logChangeTool = {
  name: "log_change",
  config: {
    title: "Log SEO change",
    description:
      "Records a change shipped to the project's site (title/meta, content, internal links, schema, redirect/canonical, technical) and snapshots Search Console for each affected page and target query over the 28 days before it: clicks, impressions, CTR and position by device. Uses no credits. OpenSEO then re-measures the same targets 14 and 28 days after the ship date on its own; read the result with get_change_impact. Log one change per deploy or logical edit, right after it ships, with the before/after title and description when they changed and the commit, deploy ID or PR link.",
    inputSchema: logInputSchema,
    outputSchema: logOutputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof logInputSchema>>, context) => {
      const { projectId, ...input } = args;
      const { change, baseline } = await SeoChangeService.logChange({
        projectId,
        createdByUserId: context.auth.userId,
        author:
          input.author ?? context.auth.clientLabel ?? DEFAULT_CLIENT_LABEL,
        authorKind: "agent",
        input,
      });
      const path = changesPath(projectId);
      const params = { changeId: change.id };
      const url = buildDashboardUrl(context.baseUrl, path, params);

      await captureServerEvent({
        distinctId: context.auth.userId,
        event: "seo_change:logged",
        organizationId: context.auth.organizationId,
        properties: {
          project_id: projectId,
          type: change.type,
          target_count: change.targets.length,
          baseline_status: baseline.status,
          client: context.auth.clientLabel,
          source: "mcp",
        },
      });

      const baselineText =
        baseline.status === "measured"
          ? `Baseline stored for ${baseline.windowStart}..${baseline.windowEnd}.`
          : `Baseline not taken yet: ${baseline.error ?? "it will be measured shortly"}`;
      return mcpResponse({
        text: [
          `Logged change ${change.id} (shipped ${change.shipDate}). ${baselineText}`,
          "Post-change results land 14 and 28 days after the ship date, plus ~3 days for Search Console to settle; read them with get_change_impact.",
          `Open it at ${url}`,
        ].join("\n"),
        meta: buildProjectMeta(context, projectId, path, params),
        structuredContent: { changeId: change.id, change, baseline, url },
      });
    },
  ),
};

// --------------------------------------------------------------- list_changes

const listInputSchema = {
  projectId: projectIdSchema,
  ...seoChangeListFiltersSchema.shape,
} as const;

const listOutputSchema = z.looseObject({
  changes: z.array(looseObjectOutputSchema),
  rowCount: z.number(),
  ...optionalMetaOutputSchema,
});

export const listChangesTool = {
  name: "list_changes",
  config: {
    title: "List SEO changes",
    description:
      "Lists changes logged for this project, newest ship date first: what changed, which pages and queries, who shipped it, and whether it was reverted. Uses no credits. Filter by page URL, change type or ship-date range. Check this before editing a page so you don't redo or undo a recent change, then use get_change_impact for its measured effect.",
    inputSchema: listInputSchema,
    outputSchema: listOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof listInputSchema>>, context) => {
      const { projectId, ...filters } = args;
      const changes = await SeoChangeService.listChanges(projectId, filters);
      return mcpResponse({
        text:
          changes.length > 0
            ? `${changes.map(changeLine).join("\n\n")}\n\n${changes.length} shown.`
            : "No changes match. Log one with log_change after it ships.",
        meta: buildProjectMeta(context, projectId, changesPath(projectId)),
        structuredContent: { changes, rowCount: changes.length },
      });
    },
  ),
};

// ---------------------------------------------------------- get_change_impact

const impactInputSchema = {
  projectId: projectIdSchema,
  changeId: changeIdSchema,
} as const;

const impactOutputSchema = z.looseObject({
  change: looseObjectOutputSchema,
  checkpoints: z.array(looseObjectOutputSchema),
  baseline: z.array(looseObjectOutputSchema),
  results: z.array(looseObjectOutputSchema),
  ...optionalMetaOutputSchema,
});

export const getChangeImpactTool = {
  name: "get_change_impact",
  config: {
    title: "Get SEO change impact",
    description:
      "Shows what a logged change did: the stored 28-day baseline and, for each measured post-change window (14 and 28 days after the ship date), clicks and impressions per day, CTR and average position by device with deltas, the whole site's change over the same window, and noise flags (low_volume, matches_site_trend). Uses no credits. A window that has settled but was not measured yet is measured on this call.",
    inputSchema: impactInputSchema,
    outputSchema: impactOutputSchema,
    annotations: {
      // May store a due measurement, but never changes what a reader sees
      // except by filling it in.
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof impactInputSchema>>, context) => {
      const impact = await SeoChangeService.getChangeImpact(
        args.projectId,
        args.changeId,
      );
      return mcpResponse({
        text: renderImpactText(impact),
        meta: buildProjectMeta(
          context,
          args.projectId,
          changesPath(args.projectId),
          { changeId: args.changeId },
        ),
        structuredContent: impact,
      });
    },
  ),
};

// -------------------------------------------------------------- update_change

const updateInputSchema = {
  projectId: projectIdSchema,
  changeId: changeIdSchema,
  ...seoChangeUpdateSchema.shape,
} as const;

const updateOutputSchema = z.looseObject({
  change: looseObjectOutputSchema,
  ...optionalMetaOutputSchema,
});

export const updateChangeTool = {
  name: "update_change",
  config: {
    title: "Update SEO change",
    description:
      "Adds a note to a logged change, marks it reverted (or not), or fills in its summary, commit, deploy ID or PR link. Uses no credits. Marking a change reverted skips the measurements whose window had not closed by the revert, since they would mix both versions. The ship date and targets are fixed; log a new change instead of rewriting one.",
    inputSchema: updateInputSchema,
    outputSchema: updateOutputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof updateInputSchema>>, context) => {
      const { projectId, changeId, ...update } = args;
      const change = await SeoChangeService.updateChange(
        projectId,
        changeId,
        update,
      );
      return mcpResponse({
        text: `Updated change.\n\n${changeLine(change)}${
          change.notes ? `\n\nNotes:\n${change.notes}` : ""
        }`,
        meta: buildProjectMeta(context, projectId, changesPath(projectId), {
          changeId,
        }),
        structuredContent: { change },
      });
    },
  ),
};
