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
 *   - waiting_k: lib/quota-waiting.ts waitingDemand (cached 240 s). A held
 *     term is capped at what k may still spend under its own max (a consumer
 *     at its max holds nothing back).
 *   - spent: the D1 ledger for the quota day plus the units this invocation
 *     counted and has not written yet (google-oauth.ts pendingLedgerUnits).
 *   - pool remaining: what the projects with a token that are not flagged out
 *     have left, less this invocation's unwritten units.
 *   - max: checked here against the ledger only for consumers without an
 *     exact counter of their own. likes, combined, hygiene and ordering
 *     enforce theirs through their KV counters (dailyMaxUnits): the ledger's
 *     consumer is module-global, and a comparison's reads are not removals.
 *   - mkvid_uploads spends the upload bucket, not this pool: never gated,
 *     never holds anything back, its min / max are ignored.
 *   - The pool, ledger and waiting reads are memoised per env for
 *     SNAPSHOT_MEMO_MS (a sync asks before every insert); the units still in
 *     memory are added fresh on every call.
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
export const OWNER = "owner" as const;

/** The ranked consumer keys (lib/quota-consumers.ts has the catalogue). */
export type QuotaConsumerKey =
  | "likes"
  | "yt_subscriptions"
  | "presave_playlists"
  | "dj_playlists"
  | "hygiene"
  | "mkvid_uploads"
  | "mkvid_recreate"
  | "genre_playlists"
  | "combined"
  | "renames"
  | "ordering";

/** Consumers whose daily max is enforced by an exact counter of their own, not the ledger. */
const OWN_COUNTER: ReadonlySet<string> = new Set(["likes", "combined", "hygiene", "ordering"]);
/** Spends the upload bucket only (spec, "Uploads"). */
const OUTSIDE_POOL = "mkvid_uploads";
/** How long one read of the pool, the ledger and the waiting work serves the gate. */
const SNAPSHOT_MEMO_MS = 5_000;

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

/** Units spent today by consumer, as the ledger has them. Never throws. */
async function ledgerByConsumer(env: Env, nowMs: number): Promise<Map<string, number>> {
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
  return spent;
}

/** The memoised part: what D1 and KV said, before this invocation's unwritten units. */
type Reads = {
  margin: number;
  /** null when the pool could not be read: then nothing is held for it. */
  remaining: number | null;
  /** Some project has a token, is not flagged out and has at least the margin left. */
  usable: boolean;
  ledger: Map<string, number>;
  waiting: Record<string, number>;
};

const memo = new WeakMap<object, { at: number; reads: Reads }>();

async function reads(env: Env, nowMs: number): Promise<Reads> {
  const hit = memo.get(env);
  // Keyed by the clock it was read at: a caller with another `nowMs` (a test's time travel) reads again.
  if (hit && nowMs >= hit.at && nowMs - hit.at < SNAPSHOT_MEMO_MS) return hit.reads;
  const { margin } = await poolLimits(env);
  const projects = await poolProjects(env, nowMs);
  const live = projects.filter((p) => p.hasToken && !p.out);
  const r: Reads = {
    margin,
    remaining:
      projects.length === 0 ? null : live.reduce((a, p) => a + Math.max(0, p.remaining), 0),
    usable: live.some((p) => p.remaining >= margin),
    ledger: await ledgerByConsumer(env, nowMs),
    waiting: await waitingDemand(env, nowMs),
  };
  memo.set(env, { at: nowMs, reads: r });
  return r;
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
  const r = await reads(env, nowMs);
  const spent = new Map(r.ledger);
  let unwritten = 0;
  for (const [k, n] of pendingLedgerUnits(env)) {
    spent.set(k, (spent.get(k) ?? 0) + n);
    unwritten += n;
  }
  const remaining = r.remaining === null ? null : Math.max(0, r.remaining - unwritten);
  return {
    order: q.order,
    consumers: q.consumers,
    margin: r.margin,
    remaining,
    // youtube-pool.ts poolOut (every project out or under the margin), with the same remaining as the rule.
    out: remaining !== null && (!r.usable || remaining < r.margin),
    spent,
    waiting: r.waiting,
  };
}

const entryOf = (s: Snapshot, key: string): Entry => s.consumers[key] ?? NO_LIMITS;

/** What the ranks above `key` hold back: each one's waiting work, or what is left of its min, whichever is more. */
function heldAbove(s: Snapshot, key: string): number {
  let held = 0;
  for (const k of s.order) {
    if (k === key) break;
    const e = entryOf(s, k);
    if (!e.enabled || k === OUTSIDE_POOL) continue;
    const spent = s.spent.get(k) ?? 0;
    const left = e.min === null ? 0 : e.min - spent;
    const want = Math.max(s.waiting[k] ?? 0, left, 0);
    held += e.max === null ? want : Math.min(want, Math.max(0, e.max - spent));
  }
  return held;
}

function decide(s: Snapshot, consumer: string, units: number): GateResult {
  if (consumer === OWNER) return s.out ? { ok: false, reason: "pool_out" } : { ok: true };
  if (consumer === OUTSIDE_POOL) return { ok: true };
  const e = entryOf(s, consumer);
  if (!e.enabled) return { ok: false, reason: "off" };
  if (s.out) return { ok: false, reason: "pool_out" };
  if (!OWN_COUNTER.has(consumer) && e.max !== null && (s.spent.get(consumer) ?? 0) + units > e.max)
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
  consumer: QuotaConsumerKey | typeof OWNER,
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
 * What the OWN_COUNTER consumers have spent today in units by their own KV
 * counters (the ones their max is enforced against). Imported lazily: those
 * modules import this one. A consumer whose counter cannot be read is left out.
 */
async function ownCounterUnits(env: Env, nowMs: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const read = async (key: string, f: () => Promise<number>): Promise<void> => {
    try {
      out.set(key, await f());
    } catch {
      // Left to the ledger.
    }
  };
  await read("likes", async () => (await import("./presave-like")).likeUnitsSpent(env, nowMs));
  await read(
    "combined",
    async () => (await (await import("./combined-playlist")).dailyInsertsUsed(env)) * 50,
  );
  await read(
    "hygiene",
    async () => (await (await import("./playlist-hygiene")).sweepDeletesUsed(env, nowMs)) * 51,
  );
  await read("ordering", async () => (await import("./playlist-reorder")).orderUnitsUsedToday(env));
  return out;
}

/**
 * Every ranked consumer in the owner's order with what the gate would say
 * to one more of its actions now (its catalogue cost, 50 when none),
 * today's units and its waiting units: the quota page's list. The gate
 * leaves the max of likes, combined, hygiene and ordering to their own
 * counters, so for the page their max is checked here against those
 * counters (the ledger when one cannot be read): one parked by its counter
 * shows "max", not "running".
 */
export async function consumerStatus(
  env: Env,
  nowMs = Date.now(),
): Promise<
  Array<{
    key: string;
    /** `outside`: mkvid_uploads, which spends the upload bucket and not this pool. */
    status: "running" | "outside" | GateRefusal;
    spentToday: number;
    waiting: number;
  }>
> {
  const s = await snapshot(env, nowMs);
  const cost = new Map(QUOTA_CONSUMERS.map((c) => [c.key, c.waitingCost ?? 50]));
  const own = await ownCounterUnits(env, nowMs);
  return s.order.map((key) => {
    const units = cost.get(key) ?? 50;
    let r = decide(s, key, units);
    const e = entryOf(s, key);
    if ((r.ok || r.reason === "held") && OWN_COUNTER.has(key) && e.max !== null) {
      const spent = own.get(key) ?? s.spent.get(key) ?? 0;
      if (spent + units > e.max) r = { ok: false, reason: "max" };
    }
    return {
      key,
      status: key === OUTSIDE_POOL ? "outside" : r.ok ? "running" : r.reason,
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
  key: QuotaConsumerKey,
  env: { PLAYLIST_SWEEP_DAILY_REMOVALS?: string } = {},
): number {
  const e = migrateQuotaConsumers(settings, env).quota.consumers[key] ?? NO_LIMITS;
  if (!e.enabled) return 0;
  return e.max ?? settings.quota.projectBudget;
}
