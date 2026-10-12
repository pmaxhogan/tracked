#!/usr/bin/env node
/**
 * One-off backfill: like, on the connected YouTube account, the video of every
 * pre-save that has one and is not liked yet (found or uploaded before the
 * Worker started liking them by itself; lib/presave-like.ts).
 *
 *   TRACKED_API_TOKEN=... node scripts/presave-like-backfill.mjs            # dry run: what it would like, and the cost
 *   TRACKED_API_TOKEN=... node scripts/presave-like-backfill.mjs --live     # like them (10 at most)
 *     --max <n>           like at most n videos this run (50 quota units each; default 10, so a
 *                         live run never spends more than it said it would)
 *     --include-stopped   also the ones given up on (video gone, refused, disliked)
 *     --url <origin>      default $TRACKED_URL or https://tracked.pmaxhogan.workers.dev (https only,
 *                         or http on localhost: the bearer goes there)
 *
 * The Worker does the work (POST /presave/like-backfill, a bounded page per
 * request) with the YouTube token it already holds, so no Google credential is
 * on this machine: the script only needs the Tasker bearer (the Worker's
 * API_TOKEN secret), read from TRACKED_API_TOKEN and never printed.
 *
 * Quota: one videos.getRating unit per 50 pre-saves (a dry run spends it too),
 * 50 per like. A video already liked is only marked, one you disliked is left
 * alone. Out of quota stops the run cleanly; run it again after midnight
 * Pacific, it picks up where it was (it only ever looks at pre-saves with no
 * like recorded).
 */

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const die = (msg) => {
  console.error(msg)
  process.exit(2)
}
/** The option's value; an option given with no value is an error, never its default. */
const opt = (name) => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  if (v === undefined || v.startsWith('--')) die(`${name} needs a value`)
  return v
}
if (flag('--help') || flag('-h')) {
  console.log('usage: TRACKED_API_TOKEN=... node scripts/presave-like-backfill.mjs [--live] [--max n] [--include-stopped] [--url origin]')
  process.exit(0)
}
const live = flag('--live')
const includeStopped = flag('--include-stopped')
/** Likes a live run makes when --max is not given. */
const DEFAULT_MAX = 10
const maxRaw = opt('--max')
const max = maxRaw === undefined ? DEFAULT_MAX : Number(maxRaw)
if (!Number.isInteger(max) || max < 1) die('--max must be a whole number of 1 or more')
const origin = (opt('--url') ?? process.env.TRACKED_URL ?? 'https://tracked.pmaxhogan.workers.dev').replace(/\/+$/, '')
let target
try {
  target = new URL(origin)
} catch {
  die('--url is not a URL')
}
const local = target.hostname === 'localhost' || target.hostname === '127.0.0.1'
if (target.protocol !== 'https:' && !(target.protocol === 'http:' && local)) die('--url must be https (http only on localhost / 127.0.0.1): the bearer token is sent there')
const token = process.env.TRACKED_API_TOKEN
if (!token) die("TRACKED_API_TOKEN is not set (the Worker's API_TOKEN secret, the one Tasker sends).")

/** Likes one request may make (the Worker's own maximum). */
const PAGE_LIKES = 20
const name = (it) => [it.artist, it.title].filter(Boolean).join(' - ') || '(no name yet)'
const sum = { seen: 0, liked: 0, alreadyLiked: 0, wouldLike: 0, failed: 0, getRating: 0, rate: 0 }
let afterId = 0
let stoppedBy = null
let total = null

console.log(`${live ? 'LIVE' : 'DRY RUN'} against ${origin}`)
if (live) console.log(`at most ${max} likes this run: up to ${max * 50} units for videos.rate, plus 1 per 50 pre-saves read${maxRaw === undefined ? ' (--max to change)' : ''}`)
for (;;) {
  const left = max - sum.liked - sum.failed
  if (live && left <= 0) {
    stoppedBy = 'max'
    break
  }
  const res = await fetch(`${origin}/presave/like-backfill`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: !live, afterId, includeStopped, limit: Math.min(PAGE_LIKES, left) }),
  })
  if (!res.ok) {
    // 503 migration_missing: migration 0020 is not applied to the database yet.
    console.error(`the Worker answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
    process.exitCode = 1
    break
  }
  const page = await res.json()
  if (total === null) total = page.total
  for (const it of page.items) {
    sum.seen++
    console.log(`  #${it.id}  ${it.action.padEnd(13)}  ${it.videoId}  ${it.stage.padEnd(8)}  ${name(it)}${it.rating === 'unknown' ? '  (rating unknown)' : ''}${it.error ? `  [${it.error.slice(0, 160)}]` : ''}`)
  }
  sum.liked += page.liked
  sum.alreadyLiked += page.alreadyLiked
  sum.wouldLike += page.wouldLike
  sum.failed += page.failed
  sum.getRating += page.units.getRating
  sum.rate += page.units.rate
  if (page.stoppedBy) {
    stoppedBy = page.stoppedBy
    if (page.message) console.log(`stopped (${page.stoppedBy}): ${String(page.message).slice(0, 300)}`)
    // A dry run that could not read the ratings still lists the rest.
    if (live || page.nextAfterId === null) break
  }
  if (page.nextAfterId === null) break
  afterId = page.nextAfterId
}

if (process.exitCode !== 1) {
  console.log('')
  console.log(`pre-saves with a video and no like: ${total ?? 0}`)
  if (live) {
    console.log(`liked ${sum.liked}, already liked ${sum.alreadyLiked}, failed ${sum.failed}`)
    console.log(`quota spent: about ${sum.getRating + sum.rate} units (${sum.getRating} getRating + ${sum.rate} rate)`)
    if (stoppedBy === 'quota') console.log('Out of YouTube quota. Run it again after midnight Pacific; what is liked stays liked.')
    if (stoppedBy === 'rate_limit') console.log('YouTube is limiting requests. Run it again in a few minutes.')
    if (stoppedBy === 'max') console.log('Stopped at --max. Run it again for the rest.')
  } else {
    const cap = Math.min(sum.wouldLike, max)
    console.log(`would like ${sum.wouldLike}${cap < sum.wouldLike ? ` (${cap} a run with --max ${max})` : ''}, already liked ${sum.alreadyLiked} (only marked, free)`)
    console.log(`liking all ${sum.wouldLike} costs about ${sum.wouldLike * 50 + sum.getRating} units (${sum.wouldLike} x 50 rate + ${sum.getRating} getRating); this dry run spent ${sum.getRating}`)
    if (stoppedBy) console.log(`The ratings could not be read (${stoppedBy}), so every video is counted as not liked yet.`)
    console.log('Nothing was liked. Add --live to do it.')
  }
  if (stoppedBy === 'not_connected' || stoppedBy === 'error') process.exitCode = 1
}
