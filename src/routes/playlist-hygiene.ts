/**
 * Playlist hygiene routes (lib/playlist-hygiene.ts), mounted inside the
 * /subscriptions sub-app, so Cloudflare Access gates every one of them:
 *
 *   GET  /subscriptions/removed                     what was (or in a dry run would be) removed, and why
 *   GET  /subscriptions/api/removals                the rows behind it, settings, holds
 *   POST /subscriptions/api/removals/:id/undo       re-add (or, for a dry-run row, keep) one video
 *   POST /subscriptions/api/removals/holds/:playlistId/approve   apply a held comparison once
 *   POST /subscriptions/api/hygiene/run?what=compare|sweep       run one step now
 *   POST /subscriptions/api/set/remove-replace      the set card's "remove and replace" button
 */

import { Hono } from 'hono'
import type { Env } from '../types'
import { getAccessToken } from '../lib/google-oauth'
import { makeLogger } from '../lib/log'
import {
  approveHold,
  listHolds,
  listRemovals,
  removalCounts,
  REASON_LABELS,
  removeAndReplace,
  runPlaylistHygiene,
  sweepDeletesUsed,
  sweepSettings,
  undoRemoval,
} from '../lib/playlist-hygiene'
import { parseDjSlug } from '../lib/subscriptions'
import { normalizeTracklistUrl } from '../lib/tracklists1001'

export const hygieneApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>()

const reqLog = (c: { req: { raw: Request }; get: (k: 'cfAccessEmail') => string }, route: string) =>
  makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route, by: c.get('cfAccessEmail') })

hygieneApp.get('/removed', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.html(REMOVED_PAGE_HTML)
})

hygieneApp.get('/api/removals', async (c) => {
  const before = Number(c.req.query('before'))
  const page = await listRemovals(c.env, { limit: Number(c.req.query('limit')) || 200, before: Number.isFinite(before) && before > 0 ? before : null })
  return c.json({
    ...page,
    counts: await removalCounts(c.env),
    settings: sweepSettings(c.env),
    deletesUsedToday: await sweepDeletesUsed(c.env),
    holds: await listHolds(c.env),
    reasonLabels: REASON_LABELS,
  })
})

hygieneApp.post('/api/removals/:id/undo', async (c) => {
  const log = reqLog(c, 'subs.hygiene.undo')
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid_id' }, 400)
  const token = await getAccessToken(c.env)
  if (!token) return c.json({ error: 'youtube_not_connected' }, 409)
  const r = await undoRemoval(c.env, token.accessToken, id, log)
  if (!r.ok) return c.json({ error: r.error }, r.error === 'not_found' ? 404 : 409)
  return c.json(r)
})

hygieneApp.post('/api/removals/holds/:playlistId/approve', async (c) => {
  const ok = await approveHold(c.env, c.req.param('playlistId'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not_held' }, 404)
})

hygieneApp.post('/api/hygiene/run', async (c) => {
  const what = c.req.query('what')
  if (what !== 'compare' && what !== 'sweep') return c.json({ error: 'invalid_request', message: 'what=compare|sweep' }, 400)
  const log = reqLog(c, `subs.hygiene.run.${what}`)
  return c.json(await runPlaylistHygiene(c.env, log, { force: what }))
})

hygieneApp.post('/api/set/remove-replace', async (c) => {
  const log = reqLog(c, 'subs.hygiene.remove_replace')
  const body = (await c.req.json().catch(() => null)) as { slug?: unknown; url?: unknown } | null
  const slug = typeof body?.slug === 'string' ? parseDjSlug(body.slug) : null
  const url = typeof body?.url === 'string' ? normalizeTracklistUrl(body.url) : null
  if (!slug || !url) return c.json({ error: 'invalid_request', message: 'slug and a 1001tracklists set url are required' }, 400)
  const token = await getAccessToken(c.env)
  if (!token) return c.json({ error: 'youtube_not_connected' }, 409)
  const r = await removeAndReplace(c.env, token.accessToken, { slug, setUrl: url, log })
  if (!r.ok) {
    const message = r.error === 'no_video' ? 'this set has no video in the playlists' : r.error === 'mkvid_video' ? 'the video is an mkvid render; use Delete and recreate instead' : 'set not known to the sync'
    return c.json({ error: r.error, message }, r.error === 'not_found' ? 404 : 409)
  }
  return c.json(r)
})

const REMOVED_PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tracked — removed videos</title>
<style>
  :root { color-scheme: light dark; --bg: #0e1116; --fg: #e6edf3; --muted: #8b949e; --accent: #58a6ff; --danger: #f85149; --warn: #d29922; --card: #161b22; --border: #30363d; }
  @media (prefers-color-scheme: light) { :root { --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --accent: #0969da; --danger: #cf222e; --warn: #9a6700; --card: #f6f8fa; --border: #d0d7de; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  p.lead { color: var(--muted); margin: 0 0 1rem; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .bar { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-bottom: 1rem; }
  .pill { font-size: 0.75rem; font-weight: 700; padding: 0.18rem 0.5rem; border-radius: 999px; border: 1px solid var(--border); }
  .pill.dry { color: var(--warn); border-color: var(--warn); }
  .pill.live { color: var(--danger); border-color: var(--danger); }
  button { padding: 0.3rem 0.65rem; font: inherit; font-size: 0.82rem; background: transparent; color: var(--accent); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: progress; }
  .holds { border: 1px solid var(--danger); border-radius: 8px; padding: 0.6rem 0.8rem; margin-bottom: 1rem; }
  .error { color: var(--danger); min-height: 1.2em; white-space: pre-wrap; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
  th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  td.when { white-space: nowrap; color: var(--muted); font-variant-numeric: tabular-nums; }
  .status-would_remove { color: var(--warn); }
  .status-removed, .status-recorded { color: var(--danger); }
  .status-undone { color: var(--muted); text-decoration: line-through; }
  .detail { color: var(--muted); font-size: 0.78rem; }
</style>
</head>
<body>
<main>
  <h1>Removed videos</h1>
  <p class="lead">Videos the playlist sweep removed (or, in a dry run, would remove) for not being full recordings, and videos found missing from the playlists (removed by hand, or dead) that the sync will never re-add. <a href="/subscriptions">← Subscriptions</a></p>
  <div class="bar" id="bar"></div>
  <div id="holds"></div>
  <div id="error" class="error" role="alert"></div>
  <div class="table-wrap"><table>
    <thead><tr><th>When</th><th>Source</th><th>Status</th><th>DJ / set</th><th>Video</th><th>Playlist</th><th>Why</th><th></th></tr></thead>
    <tbody id="rows"></tbody>
  </table></div>
  <p><button id="more" hidden>Older</button></p>
</main>
<script>
(() => {
  const $bar = document.getElementById('bar');
  const $holds = document.getElementById('holds');
  const $rows = document.getElementById('rows');
  const $err = document.getElementById('error');
  const $more = document.getElementById('more');
  let labels = {};
  let next = null;

  function el(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function link(href, text) { const a = el('a', text); if (/^https?:\\/\\//i.test(href)) { a.href = href; a.target = '_blank'; a.rel = 'noreferrer noopener'; } return a; }
  function when(s) { try { return new Date(s * 1000).toLocaleString(); } catch { return String(s); } }

  async function post(url) {
    const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || d.error || ('failed (' + r.status + ')'));
    return d;
  }

  function renderBar(d) {
    $bar.innerHTML = '';
    const s = d.settings || {};
    $bar.appendChild(el('span', s.dryRun ? 'DRY RUN — nothing is removed' : 'LIVE — removals are applied', 'pill ' + (s.dryRun ? 'dry' : 'live')));
    $bar.appendChild(el('span', 'deletes today ' + (d.deletesUsedToday || 0) + ' / ' + s.dailyRemovals, 'pill'));
    for (const [k, n] of Object.entries(d.counts || {})) $bar.appendChild(el('span', k.replace('_', ' ') + ': ' + n, 'pill'));
    for (const what of ['compare', 'sweep']) {
      const b = el('button', what === 'compare' ? 'Compare playlists now' : 'Run sweep now');
      b.addEventListener('click', async () => {
        b.disabled = true; $err.textContent = '';
        try { await post('/subscriptions/api/hygiene/run?what=' + what); await load(); } catch (e) { $err.textContent = e.message; } finally { b.disabled = false; }
      });
      $bar.appendChild(b);
    }
  }

  function renderHolds(holds) {
    $holds.innerHTML = '';
    if (!holds || !holds.length) return;
    const box = el('div', null, 'holds');
    box.appendChild(el('strong', 'Held: these playlists seem to have lost too much at once. Nothing was recorded for them.'));
    for (const h of holds) {
      const p = el('p', (h.kind === 'combined' ? 'Combined playlist' : (h.slug || h.playlistId)) + ': ' + h.missing + ' of ' + h.expected + ' missing (since ' + when(h.at) + ') ');
      const b = el('button', 'They really are removed — apply once');
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { await post('/subscriptions/api/removals/holds/' + encodeURIComponent(h.playlistId) + '/approve'); b.textContent = 'Approved — applies at the next comparison'; } catch (e) { $err.textContent = e.message; b.disabled = false; }
      });
      p.appendChild(b);
      box.appendChild(p);
    }
    $holds.appendChild(box);
  }

  function row(r) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', when(r.at), 'when'));
    tr.appendChild(el('td', r.source));
    tr.appendChild(el('td', r.status.replace('_', ' '), 'status-' + r.status));
    const set = el('td');
    if (r.slug) { const a = el('a', r.slug); a.href = '/subscriptions/dj/' + encodeURIComponent(r.slug); set.appendChild(a); set.appendChild(document.createElement('br')); }
    if (r.set_url) set.appendChild(link(r.set_url, (r.set_url.split('/').pop() || r.set_url).replace(/\\.html$/, '')));
    tr.appendChild(set);
    const vid = el('td'); vid.appendChild(link('https://www.youtube.com/watch?v=' + encodeURIComponent(r.video_id), r.video_id)); tr.appendChild(vid);
    const pl = el('td'); pl.appendChild(link('https://www.youtube.com/playlist?list=' + encodeURIComponent(r.playlist_id), r.playlist_kind)); tr.appendChild(pl);
    const why = el('td', labels[r.reason] || r.reason);
    if (r.detail) { why.appendChild(document.createElement('br')); why.appendChild(el('span', r.detail, 'detail')); }
    tr.appendChild(why);
    const act = el('td');
    if (r.source !== 'dead' && (r.status === 'removed' || r.status === 'recorded' || r.status === 'would_remove')) {
      const b = el('button', r.status === 'would_remove' ? 'Keep it' : 'Undo (re-add)');
      b.title = r.status === 'would_remove' ? 'Never remove this video' : 'Put the video back and never judge it again';
      b.addEventListener('click', async () => {
        b.disabled = true; $err.textContent = '';
        try { await post('/subscriptions/api/removals/' + r.id + '/undo'); b.replaceWith(el('span', 'undone', 'detail')); } catch (e) { $err.textContent = e.message; b.disabled = false; }
      });
      act.appendChild(b);
    }
    tr.appendChild(act);
    return tr;
  }

  async function load(more) {
    $err.textContent = '';
    try {
      const r = await fetch('/subscriptions/api/removals' + (more && next ? '?before=' + next : ''), { credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error || ('failed (' + r.status + ')'));
      labels = d.reasonLabels || {};
      if (!more) { $rows.innerHTML = ''; renderBar(d); renderHolds(d.holds); }
      for (const x of d.rows) $rows.appendChild(row(x));
      if (!more && !d.rows.length) { const tr = el('tr'); const td = el('td', 'Nothing removed yet.'); td.colSpan = 8; tr.appendChild(td); $rows.appendChild(tr); }
      next = d.next; $more.hidden = !next;
    } catch (e) { $err.textContent = 'failed to load: ' + e.message; }
  }
  $more.addEventListener('click', () => load(true));
  load(false);
})();
</script>
</body>
</html>`
