import { Hono } from 'hono'
import type { Env } from '../types'
import { cfAccess } from '../middleware/cf-access'
import {
  addSubscription,
  djUrlFor,
  InvalidSubscriptionInput,
  listSubscriptions,
  removeSubscription,
} from '../lib/subscriptions'
import { makeLogger, errorFields } from '../lib/log'

export const subscriptionsApp = new Hono<{
  Bindings: Env
  Variables: { cfAccessEmail: string }
}>()

subscriptionsApp.use('*', cfAccess)

subscriptionsApp.get('/', (c) => c.html(PAGE_HTML))

subscriptionsApp.get('/api/list', async (c) => {
  const subs = await listSubscriptions(c.env)
  return c.json({ subscriptions: subs })
})

subscriptionsApp.post('/api/add', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.add' })
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  const url = typeof (body as { url?: unknown })?.url === 'string' ? (body as { url: string }).url : ''
  if (!url) return c.json({ error: 'missing_url' }, 400)
  try {
    const result = await addSubscription(c.env, url)
    log.info('subs.add', { added: result.added, slug: result.subscription.slug, by: c.get('cfAccessEmail') })
    return c.json(result)
  } catch (e) {
    if (e instanceof InvalidSubscriptionInput) {
      return c.json({ error: 'invalid_url', message: e.message }, 400)
    }
    log.error('subs.add_throw', errorFields(e))
    return c.json({ error: 'internal' }, 500)
  }
})

subscriptionsApp.post('/api/remove', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.remove' })
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  const slug = typeof (body as { slug?: unknown })?.slug === 'string' ? (body as { slug: string }).slug : ''
  if (!slug) return c.json({ error: 'missing_slug' }, 400)
  try {
    const removed = await removeSubscription(c.env, slug)
    log.info('subs.remove', { slug, removed, by: c.get('cfAccessEmail') })
    return c.json({ removed })
  } catch (e) {
    if (e instanceof InvalidSubscriptionInput) {
      return c.json({ error: 'invalid_slug', message: e.message }, 400)
    }
    log.error('subs.remove_throw', errorFields(e))
    return c.json({ error: 'internal' }, 500)
  }
})

const PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tracked — DJ subscriptions</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0e1116;
    --fg: #e6edf3;
    --muted: #8b949e;
    --accent: #58a6ff;
    --danger: #f85149;
    --card: #161b22;
    --border: #30363d;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --accent: #0969da; --danger: #cf222e; --card: #f6f8fa; --border: #d0d7de; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  p.lead { color: var(--muted); margin: 0 0 1.5rem; }
  form { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
  input[type="url"] { flex: 1; padding: 0.6rem 0.75rem; font: inherit; background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; }
  input[type="url"]:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  button { padding: 0.6rem 1rem; font: inherit; background: var(--accent); color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: progress; }
  button.danger { background: transparent; color: var(--danger); border: 1px solid var(--border); padding: 0.3rem 0.6rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0.75rem; border: 1px solid var(--border); border-radius: 6px; background: var(--card); margin-bottom: 0.5rem; }
  li .slug { font-weight: 600; }
  li a { color: var(--accent); text-decoration: none; font-size: 0.85rem; }
  li a:hover { text-decoration: underline; }
  li .meta { flex: 1; min-width: 0; }
  li .meta .added { color: var(--muted); font-size: 0.8rem; }
  .empty { color: var(--muted); padding: 2rem 0; text-align: center; }
  .error { color: var(--danger); margin: 0.5rem 0 1rem; min-height: 1.2em; }
  footer { margin-top: 2rem; color: var(--muted); font-size: 0.8rem; }
</style>
</head>
<body>
<main>
  <h1>DJ subscriptions</h1>
  <p class="lead">Paste a 1001tracklists DJ URL like <code>https://www.1001tracklists.com/dj/lillypalmer/index.html</code>.</p>
  <form id="add-form">
    <input id="url" type="url" placeholder="https://www.1001tracklists.com/dj/.../index.html" required autofocus />
    <button type="submit">Add</button>
  </form>
  <div id="error" class="error" role="alert"></div>
  <ul id="list"></ul>
  <div id="empty" class="empty" hidden>No subscriptions yet.</div>
  <footer>Signed in as <span id="who"></span></footer>
</main>
<script>
(() => {
  const $list = document.getElementById('list');
  const $empty = document.getElementById('empty');
  const $error = document.getElementById('error');
  const $form = document.getElementById('add-form');
  const $url = document.getElementById('url');
  const $btn = $form.querySelector('button');

  function showError(msg) { $error.textContent = msg ?? ''; }

  function fmtDate(epoch) {
    if (!epoch) return '';
    try { return new Date(epoch * 1000).toLocaleDateString(); } catch { return ''; }
  }

  function render(subs) {
    $list.innerHTML = '';
    if (!subs.length) { $empty.hidden = false; return; }
    $empty.hidden = true;
    for (const s of subs) {
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'meta';
      const slug = document.createElement('div');
      slug.innerHTML = '<span class="slug"></span> · <a target="_blank" rel="noreferrer noopener"></a>';
      slug.querySelector('.slug').textContent = s.slug;
      const link = slug.querySelector('a');
      link.href = s.sourceUrl;
      link.textContent = 'open';
      meta.appendChild(slug);
      const added = document.createElement('div');
      added.className = 'added';
      added.textContent = s.addedAt ? 'added ' + fmtDate(s.addedAt) : '';
      meta.appendChild(added);
      li.appendChild(meta);
      const rm = document.createElement('button');
      rm.className = 'danger';
      rm.textContent = 'Remove';
      rm.addEventListener('click', () => remove(s.slug, rm));
      li.appendChild(rm);
      $list.appendChild(li);
    }
  }

  async function load() {
    showError('');
    const r = await fetch('/subscriptions/api/list', { credentials: 'same-origin' });
    if (!r.ok) { showError('failed to load (' + r.status + ')'); return; }
    const data = await r.json();
    render(data.subscriptions || []);
  }

  async function add(url) {
    showError('');
    $btn.disabled = true;
    try {
      const r = await fetch('/subscriptions/api/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ url }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showError(data.message || data.error || ('add failed (' + r.status + ')')); return; }
      $url.value = '';
      await load();
    } finally {
      $btn.disabled = false;
    }
  }

  async function remove(slug, btn) {
    showError('');
    btn.disabled = true;
    try {
      const r = await fetch('/subscriptions/api/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ slug }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        showError(data.message || data.error || ('remove failed (' + r.status + ')'));
        return;
      }
      await load();
    } finally {
      btn.disabled = false;
    }
  }

  $form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $url.value.trim();
    if (!url) return;
    add(url);
  });

  // Cf-Access-Authenticated-User-Email is forwarded by Access; surface it for confidence.
  document.getElementById('who').textContent = document.cookie.includes('CF_Authorization=') ? 'Cloudflare Access' : 'dev';

  load();
})();
</script>
</body>
</html>`
