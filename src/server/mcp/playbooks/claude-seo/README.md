# claude-seo playbooks

Vendored verbatim from [AgriciDaniel/claude-seo](https://github.com/AgriciDaniel/claude-seo)
(MIT, see `LICENSE`) at commit `e77e783e38eeb738424eb72117abbd2dacdd88af`.

The OpenSEO MCP server serves these through `list_seo_playbooks` and
`get_seo_playbook` so any connected agent can follow the methodology without
installing the Claude Code plugin locally. Only `SKILL.md` files and their
markdown references/assets are copied; the Python scripts, agents, and hooks
are not, because they can't run on the Worker. The tool output tells the agent
to substitute OpenSEO tools for those steps.

Left out on purpose: `seo-dataforseo` (OpenSEO already wraps DataForSEO),
`seo-google` (superseded by the Search Console and GA4 tools), `seo-drift`
(superseded by the change log), `seo-image-gen` (image generation), and
`seo-flow` prompt templates.

To re-sync, copy the same skills' `*.md` files from a newer upstream checkout
and update the commit above.
