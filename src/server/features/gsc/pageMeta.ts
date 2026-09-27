import { analyzeHtml } from "@/server/lib/audit/page-analyzer";
import { readBodyCapped } from "@/server/lib/audit/discovery";
import { isCrawlableUrl } from "@/server/lib/audit/url-policy";

const PAGE_FETCH_TIMEOUT_MS = 10_000;
// Titles sit in <head>; a capped read keeps a huge page from costing memory.
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

type PageMeta = {
  httpStatus: number | null;
  title: string | null;
  metaDescription: string | null;
};

const MAX_REDIRECTS = 5;
const NO_META: PageMeta = {
  httpStatus: null,
  title: null,
  metaDescription: null,
};

/** The live page's HTTP status, <title> and meta description. Search
 *  Console's APIs return neither, so a sweep reads them from the page itself.
 *  Redirects are followed by hand so every hop passes the crawler's URL
 *  policy (no private or loopback hosts). Never throws: an unreachable page
 *  is just a null status. */
export async function fetchPageMeta(url: string): Promise<PageMeta> {
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isCrawlableUrl(current)) return NO_META;
      const response = await fetch(current, {
        headers: { "User-Agent": "OpenSEO-Indexing/1.0" },
        redirect: "manual",
        signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        current = new URL(location, current).toString();
        continue;
      }
      const isHtml = (response.headers.get("content-type") ?? "").includes(
        "html",
      );
      const body = isHtml
        ? await readBodyCapped(response, MAX_PAGE_BYTES)
        : null;
      if (!isHtml) await response.body?.cancel();
      if (body === null) {
        return {
          httpStatus: response.status,
          title: null,
          metaDescription: null,
        };
      }
      const page = analyzeHtml(body, current, response.status, 0);
      return {
        httpStatus: response.status,
        title: page.title || null,
        metaDescription: page.metaDescription || null,
      };
    }
    return NO_META;
  } catch {
    return NO_META;
  }
}
