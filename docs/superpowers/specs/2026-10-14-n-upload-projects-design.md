# N upload projects (mkvid + tracked) - design

Date: 2026-10-14. Status: decided by Max (brief); details below are the
implementer's choices, marked "judgment".

## Why

mkvid uploads through two Google Cloud projects: its own (`mkvid-uploads`,
account `primary`) and tracked's (`tracked-youtube`, account `shared`).
`tracked-youtube`'s 10,000-unit day also carries tracked's sync, sweeps,
likes and reorder; on 2026-10-14 it ran out at noon Pacific. A third project,
`mkvid-uploads-2`, exists. Instead of hard-coding a third name, both sides
learn a list of upload projects.

## Success criteria

- A new project is added to mkvid by env only (no code change), connected in
  mkvid's UI, and tracked starts handing out claims for it with a default cap
  of 6 a quota day, editable in tracked's Settings (0 pauses it).
- Claim order: `primary`, then the extra projects in mkvid's configured
  order, `shared` LAST.
- Every project uploads to the same YouTube channel; connecting a project
  authorized for another channel is refused with a clear message.
- One project out of quota does not stop the others.
- Back-compat: existing `mkvid_claims` rows, `mkvid_requests.account`
  values, settings `mkvid.dailyClaimCap` / `mkvid.sharedDailyClaimCap`, env
  `MKVID_DAILY_CLAIM_CAP` / `MKVID_SHARED_DAILY_CLAIM_CAP`, and an mkvid or
  tracked from before this change all keep working.

## Project keys

A project key is `^[a-z][a-z0-9_]{0,31}$`. `primary` and `shared` are the two
built-in keys and keep their meaning. Columns that store an account
(`mkvid_requests.account`, `mkvid_claims.account`, `track_uploads.account`,
mkvid `oauth_accounts.account`, mkvid job `meta.account`) are already TEXT:
no D1 migration and no SQLite migration.

## mkvid

### Config (env)

- `GOOGLE_OAUTH_CLIENT_ID/SECRET` - project `primary` (unchanged).
- `SHARED_GOOGLE_OAUTH_CLIENT_ID/SECRET` - project `shared` (unchanged).
- `UPLOAD_PROJECTS` - comma-separated extra keys, in claim order, e.g.
  `uploads2`. For each key `k`, with `K` = `k` upper-cased:
  - `K_GOOGLE_OAUTH_CLIENT_ID`, `K_GOOGLE_OAUTH_CLIENT_SECRET` (required; a
    key without both is skipped with a startup warning),
  - `K_GOOGLE_PROJECT` (optional label, the GCP project id; default = key).
    The prefix rule is the one `SHARED_` already follows (judgment: named over
    indexed or JSON - readable in compose, no quoting).
- Optional labels for the built-ins: `GOOGLE_PROJECT` (default
  `mkvid-uploads`), `SHARED_GOOGLE_PROJECT` (default `tracked-youtube`).
- Invalid keys, duplicates and `primary`/`shared` inside `UPLOAD_PROJECTS` are
  skipped with a warning, never fatal.

`config.uploadProjects` is the ordered list `[primary, ...extras, shared?]`,
each `{ key, label, google }`. `config.google` / `config.googleShared` stay.

### Context

`ctx.project(key)` returns the configured project or null; `ctx.accountFor(key)`
returns `{ key, label, store, google }` and falls back to primary for an
unknown key (as today for `shared` without a client). One `TokenStore` per
project (`oauth_accounts` row keyed by project key).
`ctx.connectedAccounts()` = projects with a stored token and not out of quota,
in config order.

### OAuth

`/oauth/start?account=<key>`: state cookie `<nonce>:<key>` (as today). The
redirect URI stays `${OAUTH_REDIRECT_BASE}/oauth/callback` for every project,
so each project's OAuth client must list it.
`/oauth/callback`: exchange with that project's client, then the channel
check (`channelConflict`):

- the new token's channel id unknown (channels.list failed), or the
  primary's stored token has no channel id while another project is being
  connected -> refuse `channel_unknown` (reconnect the primary / try again);
- a non-primary project while the primary is not connected -> refuse
  `primary_not_connected` (the primary defines the channel);
- any other connected project on a different channel id -> refuse
  `channel_mismatch` (names both channel titles).
  A refused token is revoked (best effort) and not stored. The page shows a
  plain message per code (error styling: the owner must act).

### Quota-out per project

An upload that fails with a YouTube quota answer (HTTP 403 whose message
names quota / `quotaExceeded` / `uploadLimitExceeded` / "exceeded the number
of videos") marks that project out until the next midnight Pacific (kv key
`quota_out:<key>`, expiring then). `connectedAccounts()` leaves it out, so
the next claims go to the other projects. The job error reads
`youtube_quota: <key> project: <message>` (not permanent, as before). The UI
shows the project as "out of quota until midnight Pacific" (warn, not red:
it heals itself).

### tracked bridge

- Claims (`/mkvid/claim`, `/mkvid/track/claim`) send `accounts` (connected,
  in order) and `projects: [{ key, label }]` (every configured project, also
  disconnected or out of quota ones) so tracked learns labels and order.
- Staggered deploys: an older tracked rejects unknown accounts (zod enum).
  mkvid sends extra keys and `projects` only while tracked's `/mkvid/health`
  says `uploadProjects: true` (cached 10 min, like `trackUploads`); else it
  offers `primary`/`shared` only.
- A claim naming an account mkvid does not have uploads through the primary
  (as `shared` without a client does today).
- `preferredAccount` (TRACKED_SPREAD_ACCOUNTS) works on N accounts.
- Description backfill CLI: `--account <key>|all`; extra projects use the
  primary's defaults (150 updates, 7600 units) since nothing else spends
  there.

### UI

The header lists one row per configured project: label, channel title,
Connect / Disconnect, and the quota-out note. `/api/youtube/status` keeps
`connected`, `channelTitle`, `shared` and adds `projects`.

## tracked

### Accounts

`MkvidAccount` becomes `string` (project key). `MKVID_ACCOUNTS` stays
`["primary", "shared"]` (the built-ins).

Project registry: KV `CACHE` key `mkvid:projects` = `{ at, projects: [{ key,
label }] }`, rewritten only when mkvid's reported list changes. The known
projects, in claim order (`mkvidProjects`):
`primary`, then registry extras in mkvid's order, then extra keys found only
in settings `mkvid.projectCaps` (sorted), then `shared`. An offered key that
is in neither is not claimed against (mkvid always reports its projects with
the extra keys it offers). Labels: built-ins keep
`mkvid-uploads` / `tracked-youtube`; extras use the reported label, else the
key.

### Caps

- `primary`: `mkvid.dailyClaimCap` > `MKVID_DAILY_CLAIM_CAP` > 24 (unchanged).
- `shared`: `mkvid.sharedDailyClaimCap` > `MKVID_SHARED_DAILY_CLAIM_CAP` > 6
  (unchanged).
- extra `k`: `mkvid.projectCaps[k]` > 6 (`DEFAULT_PROJECT_DAILY_CLAIM_CAP`).
  `projectCaps` is a new app setting: record key -> int 0..100 or null,
  default `{}`; deep-merged like every app setting, null = default. No env
  var for extras (judgment: settings are where caps are edited now).
- Literal 0 pauses that project; usage counted from `mkvid_claims` per
  account as today.

### Claim

`claimNext` / `claimTrackUpload`: the first offered account with claims left,
in `mkvidProjects` order (so `shared` is last whatever mkvid sends);
`preferAccount` still wins while it is offered and has room. Bodies accept
any key (regex), at most 16 accounts, plus optional `projects`. Responses'
`account` is a key string. `/mkvid/health` adds `uploadProjects: true` and
its `accounts` usage covers every known project.

### Quota failures

`failMkvidRequest` and the track-upload fail path treat an error starting
`youtube_quota` like `source_busy`: back to pending, no attempt used, claim
refunded, retried after 10 minutes - on another project, since mkvid stops
offering the spent one (judgment: without this a quota-out costs an attempt
and waits `retryBackoffHours` x attempts).

### UI

- Settings -> mkvid uploads: one cap row per known extra project, injected
  from `GET /ui/api/settings` (`mkvidProjects`), path
  `mkvid.projectCaps.<key>`, blank = 6.
- mkvid page: usage tiles already iterate `accounts`; the project filter
  takes any key.

## Deploy order

1. tracked (accepts N accounts, advertises `uploadProjects`).
2. mkvid with the new env (an mkvid deployed first keeps offering
   primary/shared until tracked advertises).
3. Connect the new project in mkvid's UI.

## Testing

tracked: claim order (primary, extras in reported order, shared last, even
when mkvid lists shared earlier), per-project caps and 0 pause, default 6,
back-compat with `primary`/`shared` rows and the old settings and env vars,
registry write-on-change, quota refund path, settings route/page.
mkvid: config parsing (order, labels, skipped keys), OAuth state carrying the
project, channel check refusals, connectedAccounts excluding quota-out
projects, quota detection marking only the failing project, claim body
gating on health, preferredAccount over N.

## Deferred

- No per-project env cap var in tracked.
- No automatic re-check of channel ids for tokens connected before this
  change (the existing `shared` token is trusted as is).
