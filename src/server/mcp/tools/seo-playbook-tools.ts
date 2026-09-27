import { sort } from "remeda";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";

// SEO methodology playbooks vendored from claude-seo (MIT, see
// src/server/mcp/playbooks/claude-seo/README.md). They are static text bundled
// at build time, so both tools are free and need no project.
const playbookFiles = import.meta.glob<string>(
  "/src/server/mcp/playbooks/claude-seo/*/**/*.md",
  { query: "?raw", import: "default", eager: true },
);

const PLAYBOOK_ROOT = "/src/server/mcp/playbooks/claude-seo/";

// The playbooks were written for a local Claude Code plugin; this note maps
// the steps that can't run over MCP onto OpenSEO tools.
const SURFACE_NOTE = `> Source: claude-seo by AgriciDaniel (MIT), served by OpenSEO MCP.
> This playbook was written for a local Claude Code plugin. Over MCP you cannot
> run its bundled Python scripts (\`claude-seo run ...\`, \`python scripts/...\`),
> spawn its subagents, or use its extensions. Keep the methodology, scoring, and
> checklists; gather the evidence with OpenSEO tools instead:
> - crawl, on-page, technical, images, internal links, schema presence: run_site_audit → get_audit_status → get_audit_issues / get_audit_pages
> - PageSpeed / Lighthouse / Core Web Vitals for one URL: get_pagespeed_insights (free); CrUX across a project's top pages: get_core_web_vitals
> - indexation, sitemaps, rich results: inspect_urls, get_index_coverage, list_index_issues, get_sitemaps, get_rich_result_issues
> - Search Console queries and pages: get_search_console_performance, get_search_opportunities
> - GA4: the get_google_analytics_* tools
> - keywords, SERPs, clustering: research_keywords, get_keyword_metrics, get_serp_results, find_serp_competitors, get_ranked_keywords
> - domains and backlinks: get_domain_overview, get_backlinks_overview, get_backlinks_profile
> - local and maps: search_local_businesses, get_local_serp_results, get_business_profile, get_business_reviews, get_local_rank_grid
> - drift / before-after tracking: log_change, list_changes, get_change_impact
> If a step needs raw page HTML or robots.txt/llms.txt and your client has a web
> fetch tool, use it; otherwise say which check was skipped. Deliver reports
> with save_report.`;

type Playbook = {
  name: string;
  description: string;
  body: string;
  references: Map<string, string>;
};

const frontmatterSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().min(1),
});

function loadPlaybooks(): Playbook[] {
  const playbooks = new Map<string, Playbook>();
  const references: [string, string, string][] = [];
  for (const [path, raw] of Object.entries(playbookFiles)) {
    const [dir, ...rest] = path.slice(PLAYBOOK_ROOT.length).split("/");
    const file = rest.join("/");
    if (file !== "SKILL.md") {
      references.push([dir, file, raw]);
      continue;
    }
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
    if (!match) throw new Error(`Playbook has no frontmatter: ${path}`);
    const frontmatter = frontmatterSchema.parse(parseYaml(match[1]));
    playbooks.set(dir, {
      name: frontmatter.name,
      description: frontmatter.description.trim(),
      body: match[2].trim(),
      references: new Map(),
    });
  }
  for (const [dir, file, raw] of references) {
    playbooks.get(dir)?.references.set(file, raw.trim());
  }
  return sort([...playbooks.values()], (a, b) => a.name.localeCompare(b.name));
}

let cachedPlaybooks: Playbook[] | undefined;
const getPlaybooks = () => (cachedPlaybooks ??= loadPlaybooks());

// ---------------------------------------------------- list_seo_playbooks

const listOutputSchema = z.looseObject({
  playbooks: z.array(
    z.looseObject({
      name: z.string(),
      description: z.string(),
      references: z.array(z.string()),
    }),
  ),
  ...optionalMetaOutputSchema,
});

export const listSeoPlaybooksTool = {
  name: "list_seo_playbooks",
  config: {
    title: "List SEO playbooks",
    description:
      "Lists expert SEO methodology playbooks (from the open-source claude-seo project): technical SEO, E-E-A-T content quality, schema, GEO / AI search, agent readiness, local and maps, hreflang, e-commerce, programmatic, clustering, content briefs, SXO, backlinks, strategic plans. Uses no credits. Call it when a task needs a structured audit framework, scoring rubric, or checklist, then load one with get_seo_playbook and gather the evidence with the other OpenSEO tools.",
    inputSchema: {} as Record<string, never>,
    outputSchema: listOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: () => {
    const playbooks = getPlaybooks();
    const text = playbooks
      .map((playbook) => {
        const refs = [...playbook.references.keys()];
        return [
          `${playbook.name}: ${playbook.description}`,
          ...(refs.length > 0 ? [`  references: ${refs.join(", ")}`] : []),
        ].join("\n");
      })
      .join("\n\n");
    return mcpResponse({
      text: `${text}\n\nLoad one with get_seo_playbook({ name, reference? }).`,
      structuredContent: {
        playbooks: playbooks.map((playbook) => ({
          name: playbook.name,
          description: playbook.description,
          references: [...playbook.references.keys()],
        })),
      },
    });
  },
};

// ------------------------------------------------------ get_seo_playbook

const getInputSchema = {
  name: z
    .string()
    .describe('Playbook name from list_seo_playbooks, e.g. "seo-geo".'),
  reference: z
    .string()
    .optional()
    .describe(
      'Optional reference file inside the playbook, e.g. "references/eeat-framework.md". Omit to get the main playbook.',
    ),
} as const;

// The playbook text rides only in `text`: clients count text and
// structuredContent both, and playbooks run to tens of KB.
const getOutputSchema = z.looseObject({
  name: z.string(),
  reference: z.string().nullable(),
  references: z.array(z.string()),
  ...optionalMetaOutputSchema,
});

export const getSeoPlaybookTool = {
  name: "get_seo_playbook",
  config: {
    title: "Get SEO playbook",
    description:
      "Returns one SEO methodology playbook (or one of its reference files) from list_seo_playbooks, with notes mapping its local-only script steps onto OpenSEO tools. Uses no credits. Follow its framework and scoring; fetch reference files only when the playbook points to them for the step you are on.",
    inputSchema: getInputSchema,
    outputSchema: getOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: (args: z.infer<z.ZodObject<typeof getInputSchema>>) => {
    const playbooks = getPlaybooks();
    const playbook = playbooks.find(
      (candidate) => candidate.name === args.name,
    );
    if (!playbook) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Unknown playbook "${args.name}". Available: ${playbooks.map((p) => p.name).join(", ")}.`,
      );
    }
    const references = [...playbook.references.keys()];
    let content = playbook.body;
    if (args.reference) {
      const reference = playbook.references.get(args.reference);
      if (reference === undefined) {
        throw new AppError(
          "VALIDATION_ERROR",
          references.length > 0
            ? `"${args.name}" has no reference "${args.reference}". Available: ${references.join(", ")}.`
            : `"${args.name}" has no reference files.`,
        );
      }
      content = reference;
    }
    const footer =
      !args.reference && references.length > 0
        ? `\n\nReference files (load with get_seo_playbook({ name: "${playbook.name}", reference })): ${references.join(", ")}`
        : "";
    return mcpResponse({
      text: `${SURFACE_NOTE}\n\n${content}${footer}`,
      structuredContent: {
        name: playbook.name,
        reference: args.reference ?? null,
        references,
      },
    });
  },
};
