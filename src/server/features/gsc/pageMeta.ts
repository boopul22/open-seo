import { analyzeHtml } from "@/server/lib/audit/page-analyzer";
import { readBodyCapped } from "@/server/lib/audit/discovery";

const PAGE_FETCH_TIMEOUT_MS = 10_000;
// Titles sit in <head>; a capped read keeps a huge page from costing memory.
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

type PageMeta = {
  httpStatus: number | null;
  title: string | null;
  metaDescription: string | null;
};

/** The live page's HTTP status, <title> and meta description. Search
 *  Console's APIs return neither, so a sweep reads them from the page itself.
 *  Never throws: an unreachable page is just a null status. */
export async function fetchPageMeta(url: string): Promise<PageMeta> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "OpenSEO-Indexing/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
    });
    const isHtml = (response.headers.get("content-type") ?? "").includes(
      "html",
    );
    const body = isHtml ? await readBodyCapped(response, MAX_PAGE_BYTES) : null;
    if (!isHtml) await response.body?.cancel();
    if (body === null) {
      return {
        httpStatus: response.status,
        title: null,
        metaDescription: null,
      };
    }
    const page = analyzeHtml(body, response.url || url, response.status, 0);
    return {
      httpStatus: response.status,
      title: page.title || null,
      metaDescription: page.metaDescription || null,
    };
  } catch {
    return { httpStatus: null, title: null, metaDescription: null };
  }
}
