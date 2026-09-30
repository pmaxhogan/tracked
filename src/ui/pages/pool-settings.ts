// Pool settings page: tlpool's budget and browser limits, the recheck schedule, priority order and the render feeder.
import { shell } from '../shell'
import { POOL_CSS, COMMON_JS } from './pool-common'

const BODY = /* html */ `
<div class="tk-grid two">
  <form id="lim" class="tk-card" autocomplete="off">
    <h2>Budget and browser</h2>
    <div id="lim-err" class="error"></div>
    <div class="field"><label for="budget">Pages per account per day</label><input id="budget" type="number" min="0" max="1000" step="1" /><span class="hint">Default 30. Spread around the clock with random gaps.</span></div>
    <div class="field"><label>Ramp for new accounts</label><div class="row"><span>Day 1</span><input id="ramp1" type="number" min="0" max="1000" step="1" /><span>Day 2</span><input id="ramp2" type="number" min="0" max="1000" step="1" /><span class="muted">then the full budget</span></div><span class="hint">Default 10, then 20.</span></div>
    <div class="field"><label for="share">Reserved for the phone button</label><div class="row"><input id="share" type="number" min="0" max="90" step="1" /><span>% of each day's budget</span></div></div>
    <div class="field"><label for="xhr">Link lookups per account per day</label><input id="xhr" type="number" min="0" max="2000" step="1" /><span class="hint">In-page lookups (media links, older-sets pages) on their own budget. Default 60.</span></div>
    <div class="field"><label>Share of the budget each kind of work may use</label><div class="row"><span>New</span><input id="ceil-new" type="number" min="0" max="100" step="1" /><span>Verify</span><input id="ceil-verify" type="number" min="0" max="100" step="1" /><span>Recheck</span><input id="ceil-recheck" type="number" min="0" max="100" step="1" /><span>Backfill</span><input id="ceil-backfill" type="number" min="0" max="100" step="1" /><span class="muted">%</span></div><span class="hint">The phone button can always use everything. Defaults 100, 100, 90, 75: backfill stops first.</span></div>
    <div class="field"><label for="images">First-party images</label><select id="images"><option value="block">Block</option><option value="allow">Allow</option></select><span class="hint">Video, ads and ad scripts are always blocked.</span></div>
    <div class="row"><span id="lim-msg" class="muted"></span><span class="spacer"></span><button id="lim-save" type="submit" class="btn primary">Save</button></div>
  </form>

  <form id="sch" class="tk-card" autocomplete="off">
    <h2>Recheck schedule</h2>
    <div id="sch-err" class="error"></div>
    <p class="muted sub" style="margin-top:0">How often a set is fetched again, by its age.</p>
    <table class="sched"><thead><tr><th>Sets up to (days old)</th><th>Every (hours)</th><th></th></tr></thead><tbody id="sch-rows"></tbody></table>
    <div class="row" style="margin:var(--sp-2) 0 var(--sp-3)"><button id="sch-add" type="button" class="btn small">+ Add row</button></div>
    <div class="field"><label for="beyond">Older than the last row: every (hours)</label><input id="beyond" type="number" min="1" step="1" placeholder="never" /><span class="hint">Empty = never (the default).</span></div>
    <div class="field"><label for="over180">Older sets without a good video or with ID rows: every (hours)</label><input id="over180" type="number" min="1" step="1" placeholder="never" /><span class="hint">Default 2160 (90 days).</span></div>
    <h2 class="next">Priority order</h2>
    <p class="muted sub" style="margin-top:0">When the budget runs short, earlier ones go first.</p>
    <div id="prios"></div>
    <div class="field" style="margin-top:var(--sp-3)"><label for="feed">Render feeder: first fetches a day</label><input id="feed" type="number" min="0" max="500" step="1" /><span class="hint">Sets mkvid is waiting on with no verified list, oldest request first, as verification fetches. Each fed set costs about 2 page views (the second fetch follows). Default 40; 0 = off.</span></div>
    <div class="row" style="margin-top:var(--sp-3)"><span id="sch-msg" class="muted"></span><span class="spacer"></span><button id="sch-save" type="submit" class="btn primary">Save</button></div>
  </form>
</div>
`

const JS = /* js */ `
(() => {
${COMMON_JS}
  // ── tlpool's own settings, via /api/pool/limits ───────────────────────
  let lim = null;
  async function loadLimits() {
    const r = await api('/limits');
    if (!r.ok) { $('lim-err').textContent = errText(r.data, r.status); $('lim-save').disabled = true; return; }
    lim = r.data.settings;
    $('budget').value = lim.budgetPerDay ?? '';
    $('ramp1').value = lim.ramp && lim.ramp[0] != null ? lim.ramp[0] : '';
    $('ramp2').value = lim.ramp && lim.ramp[1] != null ? lim.ramp[1] : '';
    $('share').value = lim.reservedPhoneShare != null ? Math.round(lim.reservedPhoneShare * 100) : '';
    $('xhr').value = lim.xhrBudgetPerDay ?? '';
    for (const p of ['new', 'verify', 'recheck', 'backfill']) $('ceil-' + p).value = lim.priorityCeilings && lim.priorityCeilings[p] != null ? Math.round(lim.priorityCeilings[p] * 100) : '';
    if (lim.imagePolicy) {
      if (![...$('images').options].some((o) => o.value === lim.imagePolicy)) $('images').add(new Option(lim.imagePolicy, lim.imagePolicy));
      $('images').value = lim.imagePolicy;
    }
    $('lim-save').disabled = false; $('lim-err').textContent = '';
  }
  $('lim').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const n = (id) => $(id).value === '' ? null : Number($(id).value);
    const body = {};
    if (n('budget') != null) body.budgetPerDay = n('budget');
    if (n('ramp1') != null && n('ramp2') != null) body.ramp = [n('ramp1'), n('ramp2')];
    if (n('share') != null) body.reservedPhoneShare = n('share') / 100;
    if ($('images').value) body.imagePolicy = $('images').value;
    if (n('xhr') != null) body.xhrBudgetPerDay = n('xhr');
    const ceil = {};
    for (const p of ['new', 'verify', 'recheck', 'backfill']) if (n('ceil-' + p) != null) ceil[p] = n('ceil-' + p) / 100;
    if (Object.keys(ceil).length) body.priorityCeilings = ceil;
    $('lim-save').disabled = true; $('lim-msg').textContent = 'saving…';
    const r = await api('/limits', jsonInit('PUT', body));
    $('lim-save').disabled = false;
    if (!r.ok) { $('lim-msg').textContent = ''; $('lim-err').textContent = errText(r.data, r.status); return; }
    $('lim-err').textContent = ''; $('lim-msg').textContent = 'Saved.';
    if (typeof TK !== 'undefined') TK.toast('Saved.');
    loadLimits();
  });

  // ── recheck schedule and priorities, via /api/pool/settings ──
  // The stored shape is lib/pool-settings.ts PoolSettings; PUT deep-merges a
  // partial document, and arrays (bands, order) replace.
  const PRIO_WORDS = { phone: 'Phone button', new: 'New sets', verify: 'Verification second fetches', recheck: 'Routine rechecks', backfill: 'DJ backfill' };
  let sched = null;
  function rowHtml(b) {
    return '<tr><td><input type="number" min="1" step="1" data-k="maxAgeDays" value="' + esc(b.maxAgeDays ?? '') + '" /></td>' +
      '<td><input type="number" min="1" step="1" data-k="intervalHours" value="' + esc(b.intervalHours ?? '') + '" /></td>' +
      '<td><button type="button" class="btn small" data-del="1" aria-label="Remove row">✕</button></td></tr>';
  }
  function renderSched() {
    $('sch-rows').innerHTML = sched.recheck.bands.map(rowHtml).join('');
    $('beyond').value = sched.recheck.beyondIntervalHours ?? '';
    $('over180').value = sched.recheck.beyondExceptionIntervalHours ?? '';
    $('feed').value = sched.renderFeedPerDay ?? '';
    renderPrios();
  }
  function renderPrios() {
    const p = sched.priorities.order;
    $('prios').innerHTML = '<div class="prio"><span class="n">0.</span><span class="name">' + esc(PRIO_WORDS.phone) + '</span><span class="muted">always first (its share is reserved in the pool)</span></div>' +
      p.map((name, i) => '<div class="prio"><span class="n">' + (i + 1) + '.</span><span class="name">' + esc(PRIO_WORDS[name] || name) + '</span>' +
      '<button type="button" class="btn small" data-up="' + i + '" ' + (i === 0 ? 'disabled' : '') + ' aria-label="Move up">↑</button>' +
      '<button type="button" class="btn small" data-down="' + i + '" ' + (i === p.length - 1 ? 'disabled' : '') + ' aria-label="Move down">↓</button></div>').join('');
  }
  function readRows() {
    return [...$('sch-rows').querySelectorAll('tr')].map((tr) => {
      const v = (k) => tr.querySelector('[data-k=' + k + ']').value;
      return { maxAgeDays: v('maxAgeDays') === '' ? null : Number(v('maxAgeDays')), intervalHours: v('intervalHours') === '' ? null : Number(v('intervalHours')) };
    });
  }
  const numOrNull = (id) => $(id).value === '' || $(id).value == null ? null : Number($(id).value);
  async function loadSched() {
    const r = await fetch('/ui/api/pool/settings', { credentials: 'same-origin' }).catch(() => null);
    if (!r) { $('sch-err').textContent = errText({ error: 'network' }); $('sch-save').disabled = true; return; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.settings || !d.settings.recheck || !Array.isArray(d.settings.recheck.bands)) { $('sch-err').textContent = errText(d, r.status); $('sch-save').disabled = true; return; }
    sched = d.settings;
    $('sch-err').textContent = ''; $('sch-save').disabled = false;
    renderSched();
  }
  $('sch-add').addEventListener('click', () => { if (!sched) return; sched.recheck.bands = readRows(); sched.recheck.bands.push({ maxAgeDays: null, intervalHours: null }); renderSched(); });
  $('sch').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b || !sched) return;
    if (b.dataset.del) { b.closest('tr').remove(); return; }
    const p = sched.priorities.order;
    if (b.dataset.up) { const i = Number(b.dataset.up); [p[i - 1], p[i]] = [p[i], p[i - 1]]; renderPrios(); }
    if (b.dataset.down) { const i = Number(b.dataset.down); [p[i + 1], p[i]] = [p[i], p[i + 1]]; renderPrios(); }
  });
  $('sch').addEventListener('submit', async (ev) => {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (!sched) return;
    const rows = readRows();
    if (rows.some((r) => !(r.maxAgeDays > 0) || !(r.intervalHours > 0))) { $('sch-err').textContent = 'Every row needs an age in days and an interval in hours.'; return; }
    rows.sort((a, b) => a.maxAgeDays - b.maxAgeDays);
    const recheck = { beyondIntervalHours: numOrNull('beyond'), beyondExceptionIntervalHours: numOrNull('over180') };
    if (rows.length) recheck.bands = rows;
    const body = { recheck, priorities: { order: sched.priorities.order } };
    if (numOrNull('feed') != null) body.renderFeedPerDay = numOrNull('feed');
    $('sch-save').disabled = true; $('sch-msg').textContent = 'saving…';
    const r = await fetch('/ui/api/pool/settings', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    $('sch-save').disabled = false;
    const d = r ? await r.json().catch(() => ({})) : { error: 'network' };
    if (!r || !r.ok) { $('sch-msg').textContent = ''; $('sch-err').textContent = d && d.issues ? d.issues.join('; ') : errText(d, r ? r.status : 0); return; }
    $('sch-err').textContent = ''; $('sch-msg').textContent = 'Saved.';
    if (typeof TK !== 'undefined') TK.toast('Saved.');
    await loadSched();
  });

  loadLimits();
  loadSched();
})();
`

export const SETTINGS_PAGE_HTML = shell({
  nav: 'pool-settings',
  title: 'Pool settings',
  body: BODY,
  css: POOL_CSS,
  js: JS,
  ownNavCount: false,
})
