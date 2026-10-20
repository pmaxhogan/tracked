// The YouTube quota pool: tracked draws API quota from several Google projects
// that all write to the same channel. Its own project ("shared" = mkvid's key
// for tracked-youtube, used with tracked's stored token) and every project
// mkvid pushes an access token for (mkvid-uploads, upload2, ...).
//
//   - Pushed tokens live in KV (`yt:pool:token:<account>`, JSON, expiring with
//     the token), listed by the `yt:pool:accounts` index so nothing needs a KV
//     list. An index entry whose token expired simply reads as "no token".
//   - A project that got a daily-quota reply is out until the quota day ends
//     (`yt:quota:out:<key>`).
//   - What tracked spent per project and consumer is the D1 ledger
//     (youtube_quota_ledger); what mkvid spent on its side comes with the push
//     (`unitsToday`). remaining = budget - spent - mkvidUnits.
//   - pickProject takes the project with the most left; the legacy global flag
//     (`yt:quota:out`, lib/youtube-quota.ts) now means "the whole pool is out".
//
// Reads never throw: they run on hot paths, so a missing DB binding counts as
// nothing spent and a KV error as nothing set.
import type { Env } from "../types";
import { quotaDayEnd, quotaDayStart } from "./mkvid";

/** mkvid's key for tracked-youtube, the project tracked's stored token belongs to. */
export const OWN_PROJECT = "shared";
/** Keys mkvid names itself; any other key uses the label it sent. */
const LABELS: Record<string, string> = { shared: "tracked-youtube", primary: "mkvid-uploads" };

/** Units a project can spend per quota day (a later task makes it a setting). */
export const PROJECT_BUDGET_UNITS = 10000;
/** A project with less than this left is treated as used up (a later task makes it a setting). */
export const POOL_MARGIN_UNITS = 300;

const TOKEN_PREFIX = "yt:pool:token:";
const ACCOUNTS_KEY = "yt:pool:accounts";
const SEEN_KEY = "yt:pool:seen";
const OUT_PREFIX = "yt:quota:out:";
const LEGACY_OUT_KEY = "yt:quota:out";
/** A pushed token is dropped this long before it expires. */
const TOKEN_SKEW_SECONDS = 300;

export type PushedToken = {
  account: string;
  label: string;
  channelId: string;
  accessToken: string;
  /** Unix seconds. */
  expiresAt: number;
  /** Units mkvid spent on this project today, when it says. */
  unitsToday: number | null;
};

type StoredToken = Pick<PushedToken, "label" | "accessToken" | "expiresAt" | "unitsToday">;
type Out = { since: number; until: number };

export type PoolProject = {
  key: string;
  label: string;
  budget: number;
  /** Units tracked spent today (the ledger). */
  spent: number;
  /** Units mkvid spent today on this project. */
  mkvidUnits: number;
  remaining: number;
  out: Out | null;
  hasToken: boolean;
};

export type PushRejection = {
  account: string;
  reason: "channel" | "expired" | "own" | "invalid";
};

function projectLabel(key: string, sent?: string): string {
  return LABELS[key] ?? (sent || key);
}

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  try {
    return await env.CACHE.get<T>(key, "json");
  } catch {
    return null;
  }
}

async function readIndex(env: Env): Promise<string[]> {
  const v = await readJson<unknown>(env, ACCOUNTS_KEY);
  return Array.isArray(v) ? v.filter((a): a is string => typeof a === "string") : [];
}

function isPushed(t: Partial<PushedToken> | null | undefined): t is PushedToken {
  return (
    !!t &&
    typeof t.account === "string" &&
    t.account !== "" &&
    typeof t.channelId === "string" &&
    typeof t.accessToken === "string" &&
    t.accessToken !== "" &&
    typeof t.expiresAt === "number" &&
    Number.isFinite(t.expiresAt)
  );
}

/** Keeps the tokens mkvid pushed for tracked's own channel; reports the rest by reason. Never logs a token. */
export async function storePushedTokens(
  env: Env,
  list: PushedToken[],
  ownChannelId: string | null,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ accepted: string[]; rejected: PushRejection[] }> {
  const accepted: string[] = [];
  const rejected: PushRejection[] = [];
  for (const t of list) {
    const account = typeof t?.account === "string" ? t.account : "";
    if (!isPushed(t)) rejected.push({ account, reason: "invalid" });
    else if (t.account === OWN_PROJECT) rejected.push({ account, reason: "own" });
    else if (t.expiresAt <= nowSec) rejected.push({ account, reason: "expired" });
    else if (!ownChannelId || t.channelId !== ownChannelId)
      rejected.push({ account, reason: "channel" });
    else {
      const value: StoredToken = {
        label: t.label,
        accessToken: t.accessToken,
        expiresAt: t.expiresAt,
        unitsToday: typeof t.unitsToday === "number" ? t.unitsToday : null,
      };
      await env.CACHE.put(TOKEN_PREFIX + t.account, JSON.stringify(value), {
        expirationTtl: Math.max(60, Math.floor(t.expiresAt - nowSec - TOKEN_SKEW_SECONDS)),
      });
      accepted.push(t.account);
    }
  }
  if (accepted.length) {
    const index = [...new Set([...(await readIndex(env)), ...accepted])];
    await env.CACHE.put(ACCOUNTS_KEY, JSON.stringify(index));
  }
  await env.CACHE.put(SEEN_KEY, String(nowSec));
  return { accepted, rejected };
}

async function spentToday(env: Env, nowMs: number): Promise<Map<string, number>> {
  const spent = new Map<string, number>();
  try {
    const { results } = await env.DB.prepare(
      "SELECT project, SUM(units) AS n FROM youtube_quota_ledger WHERE day = ? GROUP BY project",
    )
      .bind(quotaDayStart(nowMs))
      .all<{ project: string; n: number }>();
    for (const r of results) spent.set(r.project, Number(r.n ?? 0));
  } catch {
    // No DB binding or a D1 error: nothing counts as spent.
  }
  return spent;
}

function live(v: Out | null, nowMs: number): Out | null {
  return v && typeof v.until === "number" && v.until * 1000 > nowMs ? v : null;
}

const usable = (p: PoolProject) => p.hasToken && !p.out && p.remaining >= POOL_MARGIN_UNITS;

/** The own project plus every key with a live pushed token, with today's numbers. The legacy global flag reads as "own project out" and moves to `yt:quota:out:shared` once another project can take over. */
export async function poolProjects(env: Env, nowMs = Date.now()): Promise<PoolProject[]> {
  try {
    const spent = await spentToday(env, nowMs);
    const make = (key: string, label: string, mkvidUnits: number, out: Out | null): PoolProject => {
      const s = spent.get(key) ?? 0;
      return {
        key,
        label,
        budget: PROJECT_BUDGET_UNITS,
        spent: s,
        mkvidUnits,
        remaining: PROJECT_BUDGET_UNITS - s - mkvidUnits,
        out,
        hasToken: true,
      };
    };

    const legacy = live(await readJson<Out>(env, LEGACY_OUT_KEY), nowMs);
    const ownFlag = live(await readJson<Out>(env, OUT_PREFIX + OWN_PROJECT), nowMs);
    const own = make(OWN_PROJECT, LABELS[OWN_PROJECT]!, 0, ownFlag ?? legacy);
    const projects = [own];
    for (const account of await readIndex(env)) {
      if (account === OWN_PROJECT) continue;
      const t = await readJson<StoredToken>(env, TOKEN_PREFIX + account);
      if (!t || typeof t.accessToken !== "string" || !(t.expiresAt * 1000 > nowMs)) continue;
      projects.push(
        make(
          account,
          projectLabel(account, t.label),
          typeof t.unitsToday === "number" ? t.unitsToday : 0,
          live(await readJson<Out>(env, OUT_PREFIX + account), nowMs),
        ),
      );
    }

    if (legacy && projects.some(usable)) {
      // The old flag was about the one project there was; another can take over now.
      if (!ownFlag) {
        await env.CACHE.put(OUT_PREFIX + OWN_PROJECT, JSON.stringify(legacy), {
          expirationTtl: Math.max(60, legacy.until - Math.floor(nowMs / 1000)),
        });
      }
      await env.CACHE.delete(LEGACY_OUT_KEY);
    }
    return projects;
  } catch {
    return [];
  }
}

/** True when every project is out or under the margin. With nothing to read (a failure) it is false, so callers keep trying. */
export async function poolOut(env: Env, nowMs = Date.now()): Promise<boolean> {
  const projects = await poolProjects(env, nowMs);
  return projects.length > 0 && !projects.some(usable);
}

/** The project to spend on: the most remaining, the own project on a tie. `accessToken: null` = tracked's stored token. */
export async function pickProject(
  env: Env,
  opts: { exclude?: string[]; nowMs?: number } = {},
): Promise<{ key: string; accessToken: string | null } | null> {
  const nowMs = opts.nowMs ?? Date.now();
  const candidates = (await poolProjects(env, nowMs)).filter(
    (p) => usable(p) && !opts.exclude?.includes(p.key),
  );
  candidates.sort(
    (a, b) =>
      b.remaining - a.remaining || Number(b.key === OWN_PROJECT) - Number(a.key === OWN_PROJECT),
  );
  const best = candidates[0];
  if (!best) return null;
  if (best.key === OWN_PROJECT) return { key: best.key, accessToken: null };
  const t = await readJson<StoredToken>(env, TOKEN_PREFIX + best.key);
  return t ? { key: best.key, accessToken: t.accessToken } : null;
}

/** The project got a daily-quota reply: out until the quota day ends. */
export async function markProjectOut(env: Env, key: string, nowMs = Date.now()): Promise<void> {
  const until = quotaDayEnd(nowMs);
  const since = Math.floor(nowMs / 1000);
  await env.CACHE.put(OUT_PREFIX + key, JSON.stringify({ since, until } satisfies Out), {
    expirationTtl: Math.max(60, until - since),
  });
}

/** Forgets a pushed token (YouTube refused it); the next push brings a new one. */
export async function dropPushedToken(env: Env, key: string): Promise<void> {
  await env.CACHE.delete(TOKEN_PREFIX + key);
  const index = await readIndex(env);
  if (index.includes(key))
    await env.CACHE.put(ACCOUNTS_KEY, JSON.stringify(index.filter((a) => a !== key)));
}

/** Adds one call's units to today's ledger row. Never throws: counting must not break the call it counts. */
export async function recordUnits(
  env: Env,
  key: string,
  consumer: string,
  units: number,
  nowMs = Date.now(),
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO youtube_quota_ledger (day, project, consumer, units, calls) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (day, project, consumer) DO UPDATE SET units = units + excluded.units, calls = calls + 1`,
    )
      .bind(quotaDayStart(nowMs), key, consumer, units)
      .run();
  } catch {
    // The ledger is bookkeeping only.
  }
}

/** Quota units YouTube charges for a call: a search read 100, any other read 1, any write 50. */
export function unitCost(method: string, url: string): number {
  if (method.toUpperCase() !== "GET") return 50;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split("?")[0] ?? url;
  }
  return path.replace(/\/+$/, "").endsWith("/search") ? 100 : 1;
}
