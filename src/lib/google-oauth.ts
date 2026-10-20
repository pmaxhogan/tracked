import type { Env } from "../types";
import {
  dropPushedToken,
  markProjectOut,
  OWN_PROJECT,
  pickProject,
  recordUnits,
} from "./youtube-pool";
import { quotaConsumer, type YoutubePoolHooks } from "./youtube-playlists";

/**
 * Google OAuth 2.0 (authorization code, offline) for YouTube playlist access.
 *
 * Single-user app: there's exactly one set of tokens stored at `oauth:google`
 * in the SUBS KV namespace. The CF Access gate already restricts access to
 * the owner; this OAuth flow lets the worker act on the owner's YouTube
 * account on their behalf for playlist create/modify operations.
 *
 * We never log tokens. The KV namespace is encrypted at rest by Cloudflare.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true";

/**
 * `youtube` is read+write for playlists/uploads/etc. - narrower than
 * `youtube.force-ssl` and sufficient for create/insert/update/delete on
 * playlists and playlistItems on the authenticated user's channel.
 */
export const YOUTUBE_SCOPES = ["https://www.googleapis.com/auth/youtube"];

const KV_KEY = "oauth:google";

export type StoredTokens = {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds. */
  expiresAt: number;
  scope: string;
  channelId: string | null;
  channelTitle: string | null;
  /** Unix seconds; first connection. */
  connectedAt: number;
};

export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    // prompt=consent forces Google to (re-)issue a refresh_token even when
    // the user has previously authorized this client. Without it, only the
    // *first* consent yields a refresh_token, which makes recovery from a
    // lost-token state impossible without manually revoking via the user's
    // Google account.
    prompt: "consent",
    state: opts.state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
};

export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  fetcher?: typeof fetch;
}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
  const f = opts.fetcher ?? fetch;
  const r = await f(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
      code: opts.code,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`oauth code exchange: ${r.status} ${body}`);
  }
  const data = (await r.json()) as TokenResponse;
  if (!data.refresh_token) {
    throw new Error(
      "oauth: missing refresh_token (Google withholds it on re-consent unless prompt=consent + access_type=offline)",
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scope: data.scope ?? "",
  };
}

export async function refreshAccessToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetcher?: typeof fetch;
}): Promise<{ accessToken: string; expiresIn: number; scope: string }> {
  const f = opts.fetcher ?? fetch;
  const r = await f(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new GoogleOAuthRefreshFailed(r.status, body);
  }
  const data = (await r.json()) as TokenResponse;
  return { accessToken: data.access_token, expiresIn: data.expires_in, scope: data.scope ?? "" };
}

/**
 * Refresh failed. `invalidGrant` is true when Google rejected the refresh
 * token itself (revoked, expired in a Testing-mode app, etc.) - that's a
 * permanent state and the stored tokens should be cleared so the UI can
 * prompt re-consent. Other failures (5xx, transient network) leave tokens
 * intact for retry.
 */
export class GoogleOAuthRefreshFailed extends Error {
  readonly status: number;
  readonly body: string;
  readonly invalidGrant: boolean;
  constructor(status: number, body: string) {
    super(`oauth refresh: ${status} ${body}`);
    this.name = "GoogleOAuthRefreshFailed";
    this.status = status;
    this.body = body;
    let invalidGrant = false;
    if (status === 400) {
      try {
        const parsed = JSON.parse(body) as { error?: string };
        invalidGrant = parsed?.error === "invalid_grant";
      } catch {
        /* non-JSON body, leave invalidGrant=false */
      }
    }
    this.invalidGrant = invalidGrant;
  }
}

export async function revokeToken(token: string, fetcher: typeof fetch = fetch): Promise<void> {
  await fetcher(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(
    () => {},
  );
}

export async function fetchChannelInfo(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<{ id: string; title: string } | null> {
  const r = await fetcher(CHANNELS_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return null;
  const data = (await r.json()) as { items?: Array<{ id: string; snippet?: { title?: string } }> };
  const item = data.items?.[0];
  if (!item) return null;
  return { id: item.id, title: item.snippet?.title ?? "" };
}

export async function loadTokens(env: Env): Promise<StoredTokens | null> {
  return ((await env.SUBS.get(KV_KEY, "json")) as StoredTokens | null) ?? null;
}

export async function saveTokens(env: Env, t: StoredTokens): Promise<void> {
  await env.SUBS.put(KV_KEY, JSON.stringify(t));
}

export async function clearTokens(env: Env): Promise<void> {
  await env.SUBS.delete(KV_KEY);
}

/** Which project every token handed out belongs to (lib/youtube-pool.ts); a token not in it is the own project's. */
const tokenProjects = new Map<string, string>();

function remember(token: string, key: string): string {
  // Tokens live an hour; a long-lived isolate must not keep every one it saw.
  if (tokenProjects.size > 200) tokenProjects.clear();
  tokenProjects.set(token, key);
  return token;
}

/** tracked's own token (refreshing if it's within 60s of expiring), or null when none is stored. */
async function ownAccessToken(
  env: Env,
  fetcher: typeof fetch,
  opts: { rejected?: string },
): Promise<{ accessToken: string; tokens: StoredTokens } | null> {
  const t = await loadTokens(env);
  if (!t) return null;
  const now = Math.floor(Date.now() / 1000);
  // `rejected`: YouTube just 401'd this token, so refresh even though it looks
  // valid - unless the stored one is already a different (newer) token.
  const forced = opts.rejected !== undefined && t.accessToken === opts.rejected;
  if (!forced && t.expiresAt - 60 > now) return { accessToken: t.accessToken, tokens: t };
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not configured");
  }
  let refreshed;
  try {
    refreshed = await refreshAccessToken({
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refreshToken: t.refreshToken,
      fetcher,
    });
  } catch (e) {
    // invalid_grant means Google revoked the refresh token (most often:
    // Testing-mode OAuth app's 7-day TTL elapsed, or the user revoked from
    // their Google account). Clear the stored tokens so the UI's connect
    // panel and the YouTube-status endpoint reflect reality instead of
    // showing a stale "connected as ..." while every sync errors.
    if (e instanceof GoogleOAuthRefreshFailed && e.invalidGrant) {
      await clearTokens(env);
    }
    throw e;
  }
  const next: StoredTokens = {
    ...t,
    accessToken: refreshed.accessToken,
    expiresAt: now + refreshed.expiresIn,
    scope: refreshed.scope || t.scope,
  };
  await saveTokens(env, next);
  return { accessToken: refreshed.accessToken, tokens: next };
}

/**
 * A usable access token for the quota pool's project with the most left
 * (lib/youtube-pool.ts pickProject): tracked's own (refreshed when it's within
 * 60s of expiring) or one mkvid pushed. `tokens` is always tracked's own stored
 * set. Null when no tokens are stored. With the whole pool out it is the own
 * token, so callers keep their quota handling.
 *
 * `rejected`: YouTube just 401'd this token. A pushed one is dropped and
 * another project picked; the own one is force-refreshed.
 */
export async function getAccessToken(
  env: Env,
  fetcher: typeof fetch = fetch,
  opts: { rejected?: string } = {},
): Promise<{ accessToken: string; tokens: StoredTokens } | null> {
  const rejectedKey = opts.rejected !== undefined ? tokenProjects.get(opts.rejected) : undefined;
  const pushedRejected = rejectedKey !== undefined && rejectedKey !== OWN_PROJECT;
  if (pushedRejected) {
    tokenProjects.delete(opts.rejected!);
    // Only while it is still the stored one: a newer push for the account stays.
    await dropPushedToken(env, rejectedKey, opts.rejected).catch(() => {});
  }
  // A pushed token's 401 says nothing about the own token: never refresh it for one.
  const own = await ownAccessToken(env, fetcher, pushedRejected ? {} : opts);
  if (!own) return null;
  const pick = await pickProject(env);
  if (pick?.accessToken)
    return { accessToken: remember(pick.accessToken, pick.key), tokens: own.tokens };
  remember(own.accessToken, OWN_PROJECT);
  return own;
}

/** Units counted since the last drain, per env and project + consumer: one ledger write each, not one per call (Workers cap subrequests). */
const ledgerPending = new Map<
  Env,
  Map<string, { key: string; consumer: string; units: number; calls: number }>
>();

/** drainYoutubeLedger waits this long at most; rows still being written then are lost (bookkeeping only). */
const LEDGER_DRAIN_LIMIT_MS = 25_000;

/** Writes the units counted so far to the ledger, one row write per project + consumer; index.ts awaits it after the request or tick. */
export async function drainYoutubeLedger(limitMs = LEDGER_DRAIN_LIMIT_MS): Promise<void> {
  const writes: Promise<void>[] = [];
  const nowMs = Date.now();
  for (const [env, rows] of ledgerPending) {
    for (const r of rows.values())
      writes.push(recordUnits(env, r.key, r.consumer, r.units, nowMs, r.calls));
  }
  ledgerPending.clear();
  if (!writes.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(writes),
    new Promise((resolve) => {
      timer = setTimeout(resolve, limitMs);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * The quota pool's side of authedFetch (see setYoutubePool): which project a
 * token spends on, the ledger, and the next project's token after a
 * daily-quota reply. Never logs a token.
 */
export function youtubePoolHooks(env: Env): YoutubePoolHooks {
  return {
    projectOf: (token) => tokenProjects.get(token) ?? OWN_PROJECT,
    spent: (key, units) => {
      const consumer = quotaConsumer();
      let rows = ledgerPending.get(env);
      if (!rows) ledgerPending.set(env, (rows = new Map()));
      const id = `${key}
${consumer}`;
      const row = rows.get(id) ?? { key, consumer, units: 0, calls: 0 };
      row.units += units;
      row.calls += 1;
      rows.set(id, row);
    },
    quotaOut: async (key) => {
      try {
        await markProjectOut(env, key);
        const pick = await pickProject(env, { exclude: [key] });
        if (!pick) return null;
        if (pick.accessToken) return remember(pick.accessToken, pick.key);
        const own = await ownAccessToken(env, fetch, {});
        return own ? remember(own.accessToken, OWN_PROJECT) : null;
      } catch {
        return null;
      }
    },
    rejected: async (key) => {
      if (key !== OWN_PROJECT) await dropPushedToken(env, key).catch(() => {});
    },
  };
}

/**
 * The refresher authedFetch uses after a YouTube 401 (see setAccessTokenRefresher).
 * Logs how long the rejected token had left, to tell early-dying tokens from
 * Google-side flakiness. Never clears tokens on a 401; only an invalid_grant
 * from the refresh itself does (inside getAccessToken).
 */
export function youtubeTokenRefresher(
  env: Env,
  log: { warn: (e: string, f?: Record<string, unknown>) => void },
) {
  return async (stale: string): Promise<string | null> => {
    const before = await loadTokens(env);
    const secondsLeft = before ? before.expiresAt - Math.floor(Date.now() / 1000) : null;
    try {
      const r = await getAccessToken(env, fetch, { rejected: stale });
      log.warn("youtube.auth_401_retry", {
        secondsLeft,
        storedWasStale: before?.accessToken === stale,
        refreshed: !!r && r.accessToken !== stale,
      });
      return r?.accessToken ?? null;
    } catch (e) {
      log.warn("youtube.auth_401_refresh_failed", {
        secondsLeft,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  };
}

export function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function redirectUriFor(reqUrl: string): string {
  const u = new URL(reqUrl);
  return `${u.origin}/ui/oauth/callback`;
}
