/**
 * "Queue for re-check now" (mkvid page drawer and set page diagnostics, for a
 * set held for too few cue times): run the Apple Music pass from the stored
 * list right away (lib/apple-backstop.ts), mark the set due now so the
 * scheduler refetches its 1001tl page through the pool within its budget
 * (lib/fetch-scheduler.ts markSetDue), and answer the readiness after the pass.
 */

import type { Env } from "../types";
import type { Logger } from "./log";
import { dbOf } from "./db";
import { tryApplyAppleCues, type AppleResult } from "./apple-backstop";
import type { AppleFetchDeps } from "./apple-album";
import { markSetDue } from "./fetch-scheduler";
import { readinessFor, type MkvidReadinessView } from "./mkvid-readiness";

export type RecheckNowResult =
  | {
      ok: true;
      id: string;
      apple: AppleResult | null;
      readiness: MkvidReadinessView | null;
      refetchQueued: true;
    }
  | { ok: false; id: string; error: "not_found" | "not_pending" };

export async function recheckNow(
  env: Env,
  id: string,
  deps: AppleFetchDeps & { log?: Logger } = {},
): Promise<RecheckNowResult> {
  const r = await dbOf(env)
    .prepare(
      "SELECT id, set_url, status, not_before, set_date, skip_id_wait FROM mkvid_requests WHERE id = ?",
    )
    .bind(id)
    .first<{
      id: string;
      set_url: string;
      status: string;
      not_before: number | null;
      set_date: string | null;
      skip_id_wait: number | null;
    }>();
  if (!r) return { ok: false, id, error: "not_found" };
  if (r.status !== "pending") return { ok: false, id, error: "not_pending" };
  const apple = await tryApplyAppleCues(env, id, deps);
  await markSetDue(env, r.set_url);
  const readiness =
    (
      await readinessFor(env, [
        {
          id,
          status: r.status,
          notBefore: r.not_before,
          setDate: r.set_date,
          skipIdWait: Number(r.skip_id_wait ?? 0) === 1,
        },
      ])
    ).get(id) ?? null;
  deps.log?.info("mkvid.recheck_now", {
    id,
    setUrl: r.set_url,
    apple: apple?.outcome ?? "failed",
    state: readiness?.state,
  });
  return { ok: true, id, apple, readiness, refetchQueued: true };
}
