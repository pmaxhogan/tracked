/**
 * The YouTube quota priority rule (docs/superpowers/specs/2026-10-20-youtube-
 * quota-pool-design.md, "The priority rule"). A consumer at rank r may spend
 * u units when both hold:
 *
 *     pool remaining - u >= sum over ranks above r of max(waiting_k, min_k - spent_k) + margin
 *     spent_r + u <= max_r   (when the owner set a maximum)
 *
 *   - Ranks are settings.quota.order; min / max / enabled are
 *     settings.quota.consumers (null = none). A consumer switched off waits
 *     for nothing and holds nothing back.
 *   - waiting_k: lib/quota-waiting.ts waitingDemand (cached 240 s).
 *   - spent: the D1 ledger for the quota day plus the units this invocation
 *     counted and has not written yet (google-oauth.ts pendingLedgerUnits).
 *   - pool remaining: what the projects with a token that are not flagged out
 *     have left, less this invocation's unwritten units.
 *   - "owner" (the like button, undo, replace, a manual sync or rename) is
 *     never ranked: it waits only for an empty pool (youtube-pool.ts poolOut).
 *
 * A refusal is not an error: the caller leaves its work queued as it does
 * for a used-up quota, charges no attempt, and logs at info.
 */
import type { Env } from "../types";
import { getAppSettings, migrateQuotaConsumers, type AppSettings } from "./app-settings";
import { quotaDayStart } from "./mkvid";
import { pendingLedgerUnits } from "./google-oauth";
import { QUOTA_CONSUMERS } from "./quota-consumers";
import { waitingDemand } from "./quota-waiting";
import { setQuotaConsumer } from "./youtube-playlists";
import { poolLimits, poolOut, poolProjects } from "./youtube-pool";

/** The consumer key UI-initiated calls spend under. */
export const OWNER = "owner";

export type GateRefusal = "held" | "max" | "off" | "pool_out";
export type GateResult = { ok: true } | { ok: false; reason: GateRefusal };

/** What each reason says on a page or a stored note (spec, "Refusals"). */
export const REFUSAL_TEXT: Record<GateRefusal, string> = {
  held: "held for higher priority",
  max: "at its daily limit",
  off: "switched off",
  pool_out: "waiting for the quota reset (midnight Pacific)",
};

type Consumers = AppSettings["quota"]["consumers"];
type Entry = Consumers[string];
const NO_LIMITS: Entry = { min: null, max: null, enabled: true };

/** Units spent today by consumer: the ledger plus what is still in memory. Never throws. */
async function spentByConsumer(env: Env, nowMs: number): Promise<Map<string, number>> {
  const spent = new Map<string, number>();
  try {
    const { results } = await env.DB.prepare(
      "SELECT consumer, SUM(units) AS n FROM youtube_quota_ledger WHERE day = ? GROUP BY consumer",
    )
      .bind(quotaDayStart(nowMs))
      .all<{ consumer: string; n: number }>();
    for (const r of results) spent.set(r.consumer, Number(r.n ?? 0));
  } catch {
    // No DB binding or a D1 error: nothing counts as spent.
  }
  for (const [k, n] of pendingLedgerUnits(env)) spent.set(k, (spent.get(k) ?? 0) + n);
  return spent;
}

type Snapshot = {
  order: string[];
  consumers: Consumers;
  margin: number;
  /** null when the pool could not be read: then nothing is held for it. */
  remaining: number | null;
  out: boolean;
  spent: Map<string, number>;
  waiting: Record<string, number>;
};

async function snapshot(env: Env, nowMs: number): Promise<Snapshot> {
  const q = (await getAppSettings(env)).quota;
  const { margin } = await poolLimits(env);
  const projects = await poolProjects(env, nowMs);
  const spent = await spentByConsumer(env, nowMs);
  let unwritten = 0;
  for (const n of pendingLedgerUnits(env).values()) unwritten += n;
  const remaining =
    projects.length === 0
      ? null
      : Math.max(
          0,
          projects
            .filter((p) => p.hasToken && !p.out)
            .reduce((a, p) => a + Math.max(0, p.remaining), 0) - unwritten,
        );
  return {
    order: q.order,
    consumers: q.consumers,
    margin,
    remaining,
    // youtube-pool.ts poolOut on the projects already read: every one out or under the margin.
    out:
      projects.length > 0 && !projects.some((p) => p.hasToken && !p.out && p.remaining >= margin),
    spent,
    waiting: await waitingDemand(env, nowMs),
  };
}

const entryOf = (s: Snapshot, key: string): Entry => s.consumers[key] ?? NO_LIMITS;

/** What the ranks above `key` hold back: each one's waiting work, or what is left of its min, whichever is more. */
function heldAbove(s: Snapshot, key: string): number {
  let held = 0;
  for (const k of s.order) {
    if (k === key) break;
    const e = entryOf(s, k);
    if (!e.enabled) continue;
    const left = e.min === null ? 0 : e.min - (s.spent.get(k) ?? 0);
    held += Math.max(s.waiting[k] ?? 0, left, 0);
  }
  return held;
}

function decide(s: Snapshot, consumer: string, units: number): GateResult {
  if (consumer === OWNER) return s.out ? { ok: false, reason: "pool_out" } : { ok: true };
  const e = entryOf(s, consumer);
  if (!e.enabled) return { ok: false, reason: "off" };
  if (s.out) return { ok: false, reason: "pool_out" };
  if (e.max !== null && (s.spent.get(consumer) ?? 0) + units > e.max)
    return { ok: false, reason: "max" };
  if (s.remaining !== null && s.remaining - units < heldAbove(s, consumer) + s.margin)
    return { ok: false, reason: "held" };
  return { ok: true };
}

/**
 * May `consumer` spend `units` now? On yes the ledger's consumer becomes
 * `consumer` (setQuotaConsumer) for the calls that follow. Never throws: a
 * failure to read anything lets the consumer spend, as before this rule.
 */
export async function quotaGate(
  env: Env,
  consumer: string,
  units: number,
  nowMs = Date.now(),
): Promise<GateResult> {
  let r: GateResult;
  try {
    if (consumer === OWNER)
      r = (await poolOut(env, nowMs)) ? { ok: false, reason: "pool_out" } : { ok: true };
    else r = decide(await snapshot(env, nowMs), consumer, units);
  } catch {
    r = { ok: true };
  }
  if (r.ok) setQuotaConsumer(consumer);
  return r;
}

/**
 * Every ranked consumer in the owner's order with what the gate would say
 * to one more of its actions now (its catalogue cost, 50 when none),
 * today's units and its waiting units: the quota page's list.
 */
export async function consumerStatus(
  env: Env,
  nowMs = Date.now(),
): Promise<
  Array<{
    key: string;
    status: "running" | GateRefusal;
    spentToday: number;
    waiting: number;
  }>
> {
  const s = await snapshot(env, nowMs);
  const cost = new Map(QUOTA_CONSUMERS.map((c) => [c.key, c.waitingCost ?? 50]));
  return s.order.map((key) => {
    const r = decide(s, key, cost.get(key) ?? 50);
    return {
      key,
      status: r.ok ? "running" : r.reason,
      spentToday: s.spent.get(key) ?? 0,
      waiting: s.waiting[key] ?? 0,
    };
  });
}

/**
 * A consumer's daily maximum in units for the code that budgets in its own
 * counter (combined inserts, hygiene removals, reorder units): the owner's
 * `max`, 0 when the consumer is off, and one project's budget when there is
 * no max (the rule itself bounds it from there). Settings not read through
 * getAppSettings get their old caps carried over first (migrateQuotaConsumers).
 */
export function dailyMaxUnits(
  settings: AppSettings,
  key: string,
  env: { PLAYLIST_SWEEP_DAILY_REMOVALS?: string } = {},
): number {
  const e = migrateQuotaConsumers(settings, env).quota.consumers[key] ?? NO_LIMITS;
  if (!e.enabled) return 0;
  return e.max ?? settings.quota.projectBudget;
}
