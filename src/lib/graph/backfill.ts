/**
 * Graph backfill from stored pages (lib/page-store.ts, R2 binding PAGES):
 * set pages tlpool already handed back are read again for their sources and
 * credits, with no pool fetch. The other half of the backfill, a refetch of
 * older sets, is the search index catch-up (lib/fetch-scheduler.ts) while
 * `graph.backfill` is on.
 *
 * Only `clean/<day>/set/...` objects (the page store's decoy check passed),
 * only sets the search index holds and that have no graph yet, and only when
 * the stored page's rows are the set's verified list
 * (`tracklistFingerprint === verifiedFingerprint`): the page store's "clean"
 * verdict is a heuristic, verification is the rule every graph write keeps.
 *
 * Resumable: the last key looked at is kept in CACHE KV (`startAfter`), and
 * once the listing is exhausted the pass is marked done. Pages stored later
 * come from fetches that wrote their graph already.
 */
import type { Env } from "../../types";
import { errorFields, type Logger } from "../log";
import { gunzipToText, SCRUB_NOTE } from "../page-store";
import { searchDbOf } from "../search/db";
import { parseSetGraph } from "../tracklist-credits";
import { parseTracklist } from "../tracklists1001";
import { tracklistFingerprint, verifiedFingerprint } from "../verification";
import { GRAPH_FORMAT, setsWithGraph, writeSetGraph } from "./store";

/** CACHE KV: the last R2 key the pass looked at. Both keys carry GRAPH_FORMAT: a format bump runs the pass again. */
export const PAGES_CURSOR_KEY = `graph:pages_after:v${GRAPH_FORMAT}`;
/** CACHE KV: the pass has read every stored page (unix seconds when it finished). */
export const PAGES_DONE_KEY = `graph:pages_done:v${GRAPH_FORMAT}`;
/** Objects one listing reads (metadata only). */
const LIST_LIMIT = 200;

export type PagesStepResult = {
  /** Objects listed. */
  listed: number;
  /** Pages read (downloaded and parsed). */
  read: number;
  /** Sets whose graph was written. */
  written: number;
  /** Pages read but not used: not the verified list, a decoy, a withheld page. */
  rejected: number;
  done: boolean;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Start the stored-pages pass over from the first stored page. */
export async function resetPagesPass(env: Env): Promise<void> {
  await env.CACHE.delete(PAGES_CURSOR_KEY);
  await env.CACHE.delete(PAGES_DONE_KEY);
}

/** Whether the stored-pages pass has finished (or cannot run: no PAGES bucket). */
export async function pagesPassDone(env: Env): Promise<boolean> {
  if (!env.PAGES) return true;
  return (await env.CACHE.get(PAGES_DONE_KEY)) !== null;
}

/**
 * One step: list from the saved position, read at most `limit` eligible
 * pages, save the position after the last object handled. Never throws.
 */
export async function graphPagesStep(
  env: Env,
  opts: { limit: number; log?: Logger; nowSec?: number },
): Promise<PagesStepResult> {
  const res: PagesStepResult = { listed: 0, read: 0, written: 0, rejected: 0, done: false };
  if (!env.PAGES || !env.SEARCH_DB || opts.limit <= 0) return { ...res, done: !env.PAGES };
  if ((await env.CACHE.get(PAGES_DONE_KEY)) !== null) return { ...res, done: true };
  const nowSec = opts.nowSec ?? nowSeconds();
  try {
    const after = (await env.CACHE.get(PAGES_CURSOR_KEY)) ?? undefined;
    const list = await env.PAGES.list({
      prefix: "clean/",
      limit: LIST_LIMIT,
      include: ["customMetadata"],
      ...(after ? { startAfter: after } : {}),
    } as R2ListOptions);
    res.listed = list.objects.length;
    const sets = list.objects
      .map((o) => ({ key: o.key, url: o.customMetadata?.url ?? "" }))
      .filter((o) => /^clean\/[^/]+\/set\//.test(o.key) && o.url);
    // Sets the index holds and the graph lacks.
    const urls = [...new Set(sets.map((s) => s.url))];
    const indexed = new Set(
      urls.length
        ? (
            await searchDbOf(env)
              .prepare(
                "SELECT set_url FROM search_sets WHERE set_url IN (SELECT value FROM json_each(?))",
              )
              .bind(JSON.stringify(urls))
              .all<{ set_url: string }>()
          ).results.map((r) => r.set_url)
        : [],
    );
    const have = await setsWithGraph(env, urls);
    let last: string | null = null;
    let stoppedEarly = false;
    for (const o of list.objects) {
      const s = sets.find((x) => x.key === o.key);
      if (s && indexed.has(s.url) && !have.has(s.url)) {
        if (res.read >= opts.limit) {
          stoppedEarly = true;
          break;
        }
        res.read++;
        if (await usePage(env, s.key, s.url, nowSec)) {
          res.written++;
          have.add(s.url);
        } else res.rejected++;
      }
      last = o.key;
    }
    if (last) await env.CACHE.put(PAGES_CURSOR_KEY, last);
    if (!stoppedEarly && !list.truncated) {
      await env.CACHE.put(PAGES_DONE_KEY, String(nowSec));
      res.done = true;
    }
  } catch (e) {
    opts.log?.warn("graph.pages_step_failed", errorFields(e));
  }
  return res;
}

/** Read one stored page and write its graph when it is the set's verified list. */
async function usePage(env: Env, key: string, url: string, nowSec: number): Promise<boolean> {
  const obj = await env.PAGES!.get(key);
  if (!obj) return false;
  const html = await gunzipToText(await obj.arrayBuffer());
  if (!html || html.startsWith(SCRUB_NOTE)) return false;
  const parsed = parseTracklist(url, html);
  if (parsed.decoy.suspected) return false;
  const fp = await verifiedFingerprint(env, url);
  if (!fp || fp !== (await tracklistFingerprint(parsed))) return false;
  await writeSetGraph(env, url, parseSetGraph(html), nowSec, "pages");
  return true;
}
