import { describe, expect, it } from "vitest";
import {
  getSeoPlaybookTool,
  listSeoPlaybooksTool,
} from "@/server/mcp/tools/seo-playbook-tools";

describe("seo playbook tools", () => {
  it("parses every vendored playbook and serves its references", () => {
    const { playbooks } = listSeoPlaybooksTool.handler().structuredContent;
    expect(playbooks.map((p) => p.name)).toContain("seo-geo");

    const result = getSeoPlaybookTool.handler({
      name: "seo",
      reference: "references/eeat-framework.md",
    });
    expect(JSON.stringify(result.content)).toContain("E-E-A-T");
  });

  it("names the available playbooks when one is unknown", () => {
    expect(() => getSeoPlaybookTool.handler({ name: "nope" })).toThrow(
      /Available: .*seo-technical/,
    );
  });
});
