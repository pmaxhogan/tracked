// YouTube quota: the pool of Google projects tracked draws from, the ranked
// list of what spends it (who goes first when it runs short), and the spending
// outside the pool. Data comes from the Access-gated GET /ui/api/quota
// (routes/quota-ui.ts); reordering and the limits save through PUT of the same
// path. Statuses are information, never red: every one resolves by itself.
import { shell } from "../shell";
import { tipAttr } from "../tip";
import type { UiPage } from ".";

const BODY = /* html */ `
  <div id="q-error" class="error" role="alert"></div>
  <section class="tk-card" aria-labelledby="q-h-pool">
    <h2 id="q-h-pool"><span class="tip-term"${tipAttr("tracked draws YouTube API quota from several Google projects that write to the same channel. Each project has its own daily budget, and all of them reset at midnight Pacific time.")}>Today's pool</span></h2>
    <div id="q-pool"></div>
  </section>
  <section class="tk-card" aria-labelledby="q-h-list">
    <h2 id="q-h-list">Priority</h2>
    <p class="muted">Each item spends only what is left after the waiting work of everything above it.</p>
    <div id="q-list"></div>
  </section>
  <section class="tk-card" aria-labelledby="q-h-out">
    <h2 id="q-h-out">Outside the pool</h2>
    <div id="q-outside"></div>
  </section>
`;

const CSS = /* css */ `
  .q-sum { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--sp-2); }
  .q-chips { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-3); }
  .q-chip { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); padding: 4px var(--sp-2); border: 1px solid var(--line); border-radius: var(--r-ctl); background: var(--elev); font-size: var(--fs-sm); min-width: 0; overflow-wrap: anywhere; }
  .q-margin { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-top: var(--sp-3); font-size: var(--fs-sm); }
  .q-margin input, .q-lim input { font: inherit; color: var(--fg); background: var(--page); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); padding: 6px 8px; width: 7rem; min-width: 0; }
  .q-row { border-top: 1px solid var(--line); padding: var(--sp-3) 0; }
  .q-row:first-child { border-top: 0; }
  .q-main { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--sp-3); align-items: start; }
  .q-move { display: flex; flex-direction: column; gap: 4px; }
  .q-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
  .q-name { font-weight: 600; overflow-wrap: anywhere; }
  .q-desc, .q-facts { color: var(--muted); font-size: var(--fs-sm); margin: 2px 0 0; overflow-wrap: anywhere; }
  .q-facts span + span::before { content: " / "; }
  .q-more { margin-top: var(--sp-2); font-size: var(--fs-sm); }
  .q-more summary { cursor: pointer; color: var(--muted); }
  .q-lim { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); margin-top: var(--sp-2); }
  .q-lim label { display: inline-flex; align-items: center; gap: var(--sp-2); }
  .q-was { color: var(--muted); }
  .q-out p { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); }
  #q-error:empty { display: none; }
`;

const JS = /* js */ `
(() => {
  const $ = TK.$, esc = TK.esc;
  const $pool = $('q-pool'), $list = $('q-list'), $outside = $('q-outside'), $err = $('q-error');
  let data = null;
  const open = {};
  const STATUS = {
    running: { cls: 'info', text: 'running', tip: 'Nothing above it is holding quota back, so it spends as work comes up.' },
    held: { cls: 'warn', text: 'held for higher priority', tip: 'The items above it are waiting for quota, so it keeps its hands off until they are done. It goes on by itself.' },
    max: { cls: 'neutral', text: 'at its daily limit', tip: 'It has spent the most you allowed it today. It goes on after the reset.' },
    pool_out: { cls: 'info', text: 'waiting for the quota reset', tip: 'Every project is used up for today. Everything goes on after midnight Pacific time.' },
    off: { cls: 'neutral', text: 'off', tip: 'Switched off here. It spends nothing and holds nothing back.' },
  };
  const badge = (cls, text, tip) => '<span class="badge ' + cls + '"' + (tip ? TK.tip(tip) : '') + '>' + esc(text) + '</span>';
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  function ptTime(sec) {
    try { return new Date(sec * 1000).toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch (e) { return ''; }
  }
  function inHm(sec) {
    const m = Math.max(0, Math.round((sec - Date.now() / 1000) / 60));
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' m';
  }
  function fail(res, fallback) { $err.textContent = TK.errText(res, fallback); }

  function renderPool() {
    const d = data;
    let spent = 0, budget = 0;
    for (const p of d.pool) { spent += (p.spent || 0) + (p.mkvidUnits || 0); budget += p.budget || 0; }
    const left = Math.max(0, budget - spent);
    const pct = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
    let h = '<div class="q-sum"><strong>' + esc(num(spent)) + ' spent, ' + esc(num(left)) + ' left of ' + esc(num(budget)) + ' units</strong>' +
      '<span class="muted">resets at midnight Pacific (in ' + esc(inHm(d.resetsAt)) + ')</span></div>' +
      '<div class="tk-meter"><i style="width:' + pct + '%"></i></div><div class="q-chips">';
    for (const p of d.pool) {
      const used = (p.spent || 0) + (p.mkvidUnits || 0);
      h += '<span class="q-chip"><span>' + esc(p.label) + ' ' + esc(num(used)) + ' of ' + esc(num(p.budget)) + '</span>' +
        (p.out ? badge('info', 'out until ' + ptTime(p.out.until) + ' PT', 'YouTube said this project is used up. It is tried again after the reset, or sooner with Clear.') : '') +
        '<button type="button" class="btn sm" data-clear="' + esc(p.key) + '"' + TK.tip('Use this when the quota was raised or reset early. The flag is set again if YouTube still refuses.') + '>Clear</button></span>';
    }
    for (const p of d.notConnected || []) {
      h += '<span class="q-chip"><span>' + esc(p.label) + '</span>' +
        badge('neutral', 'not connected' + (p.since ? ' since ' + ptTime(p.since) + ' PT' : ''), 'mkvid has stopped sending a token for this project, so tracked cannot spend its quota. It comes back by itself when mkvid pushes one.') +
        '<button type="button" class="btn sm" data-clear="' + esc(p.key) + '">Clear</button></span>';
    }
    h += '</div>';
    const seen = d.tokenSource && d.tokenSource.lastPushAt;
    if (seen && Date.now() / 1000 - seen > 600) {
      h += '<p class="q-margin">' + badge('warn', 'token source silent for ' + Math.round((Date.now() / 1000 - seen) / 60) + ' min', 'mkvid pushes the tokens of its projects about every few minutes. When it stops, tracked only has its own project to spend.') + '</p>';
    }
    h += '<div class="q-margin"><label for="q-margin">Margin: always keep</label><input id="q-margin" type="number" min="0" max="5000" step="1" value="' + esc(String(d.margin)) + '"> <span>units for your own actions</span>' +
      '<button type="button" class="btn sm" data-margin="1">Save</button></div>';
    $pool.innerHTML = h;
  }

  function limitInput(key, field, v) {
    return '<input id="q-' + field + '-' + esc(key) + '" type="number" min="0" step="1" inputmode="numeric" value="' + (v === null || v === undefined ? '' : esc(String(v))) + '" placeholder="none">';
  }
  function renderList() {
    const rows = data.consumers.map((c, i) => {
      const st = STATUS[c.status] || STATUS.running;
      const status = c.enabled ? st : STATUS.off;
      const facts = ['<span>' + esc(c.perAction) + '</span>', '<span>today ' + esc(num(c.spentToday)) + ' units</span>',
        '<span>waiting ' + (c.waiting > 0 ? esc(num(c.waiting)) + ' units' : '-') + '</span>'];
      return '<div class="q-row" data-row="' + esc(c.key) + '"><div class="q-main"><div class="q-move">' +
        '<button type="button" class="btn sm" data-up="' + esc(c.key) + '" aria-label="Move up"' + (i === 0 ? ' disabled' : '') + '>Up</button>' +
        '<button type="button" class="btn sm" data-down="' + esc(c.key) + '" aria-label="Move down"' + (i === data.consumers.length - 1 ? ' disabled' : '') + '>Down</button></div>' +
        '<div><div class="q-head"><span class="q-name">' + (i + 1) + '. ' + esc(c.label) + '</span>' + badge(status.cls, status.text, status.tip) + '</div>' +
        '<p class="q-desc">' + esc(c.description) + '</p><p class="q-facts">' + facts.join('') + '</p>' +
        '<details class="q-more" data-key="' + esc(c.key) + '"' + (open[c.key] ? ' open' : '') + '><summary>Limits</summary>' +
        '<div class="q-lim"><label>Keep at least ' + limitInput(c.key, 'min', c.min) + ' units a day</label>' +
        '<label>At most ' + limitInput(c.key, 'max', c.max) + ' units a day</label>' +
        '<label><input id="q-on-' + esc(c.key) + '" type="checkbox"' + (c.enabled ? ' checked' : '') + '> On</label>' +
        '<button type="button" class="btn sm" data-save="' + esc(c.key) + '">Save</button></div>' +
        (c.was ? '<p class="q-was">was ' + esc(c.was) + '</p>' : '') + '</details></div></div></div>';
    });
    $list.innerHTML = rows.join('');
  }

  function renderOutside() {
    const o = data.outside || {};
    let h = '<div class="q-out"><p><strong>Uploads</strong> (YouTube allows 100 a day per project; they do not use this pool)</p>';
    for (const u of o.uploads || []) {
      h += '<p>' + esc(u.label) + ': ' + esc(num(u.used)) + ' / ' + esc(num(u.limit)) + ' today, claim cap ' + esc(num(u.cap)) + '</p>';
    }
    h += '<p><a href="/ui/settings#sf-mkvid">Change the claim caps in the mkvid settings</a></p>';
    const r = o.apiKeyReads || {};
    h += '<p><strong>API-key reads</strong>: ' + (r.count === null || r.count === undefined ? 'not counted' : esc(num(r.count)) + ' today') + '; ' + esc(r.note || 'their project is unknown') + '.</p></div>';
    $outside.innerHTML = h;
  }

  function render() { renderPool(); renderList(); renderOutside(); }
  function take(res, fallback) {
    if (!res.ok) { fail(res, fallback); return false; }
    $err.textContent = '';
    if (res.data && Array.isArray(res.data.consumers)) { data = res.data; render(); }
    return true;
  }
  async function load() {
    const res = await TK.api.get('/ui/api/quota');
    if (!take(res, 'failed (' + res.status + ')')) return;
  }
  const readLimit = (id) => { const v = $(id).value; return v === '' || v == null ? null : Number(v); };

  $list.addEventListener('click', async (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const move = t.closest('button[data-up]') || t.closest('button[data-down]');
    if (move) {
      const up = !!t.closest('button[data-up]');
      const key = move.getAttribute(up ? 'data-up' : 'data-down');
      const order = data.consumers.map((c) => c.key);
      const i = order.indexOf(key), j = up ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= order.length) return;
      order[i] = order[j]; order[j] = key;
      await TK.busy(move, 'Moving...', async () => { take(await TK.api.put('/ui/api/quota', { order: order }), 'could not save the order'); });
      return;
    }
    const save = t.closest('button[data-save]');
    if (save) {
      const key = save.getAttribute('data-save');
      const entry = { min: readLimit('q-min-' + key), max: readLimit('q-max-' + key), enabled: !!$('q-on-' + key).checked };
      const consumers = {}; consumers[key] = entry;
      await TK.busy(save, 'Saving...', async () => { if (take(await TK.api.put('/ui/api/quota', { consumers: consumers }), 'could not save')) TK.toast('Saved.'); });
    }
  });
  $list.addEventListener('toggle', (e) => {
    const k = e.target && e.target.getAttribute ? e.target.getAttribute('data-key') : null;
    if (k) open[k] = !!e.target.open;
  }, true);

  $pool.addEventListener('click', async (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const clr = t.closest('button[data-clear]');
    if (clr) {
      const key = clr.getAttribute('data-clear');
      await TK.busy(clr, 'Clearing...', async () => {
        const res = await TK.api.post('/ui/api/quota/projects/' + encodeURIComponent(key) + '/clear', {});
        if (!res.ok) { fail(res, 'failed (' + res.status + ')'); return; }
        await load();
      });
      return;
    }
    const m = t.closest('button[data-margin]');
    if (m) {
      const v = Number($('q-margin').value);
      await TK.busy(m, 'Saving...', async () => { if (take(await TK.api.put('/ui/api/quota', { margin: v }), 'could not save the margin')) TK.toast('Saved.'); });
    }
  });

  load();
})();
`;

export const QUOTA_PAGE: UiPage = {
  path: "/quota",
  html: shell({
    nav: "quota",
    title: "YouTube quota",
    description:
      "Where the day's YouTube quota goes, and who goes first when it runs short. Resets at midnight Pacific time.",
    body: BODY,
    css: CSS,
    js: JS,
  }),
};
