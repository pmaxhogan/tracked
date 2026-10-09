// Captchas page: every pending challenge, polled every 15 s, as a data table
// (TKTable, local mode: tlpool answers the whole list). A row opens its
// captcha; every poll hands the table the new rows, keeping its sort.
import { shell } from '../shell'
import { POOL_CSS, COMMON_JS } from './pool-common'

const JS = /* js */ `
(() => {
${COMMON_JS}
  let rows = [], table = null;
  function columns() {
    return [
      { key: 'reason', label: 'Why', type: 'text', value: (c) => reasonText(c.reason),
        render: (c) => '<a href="/ui/captcha/' + encodeURIComponent(c.id) + '"><b>' + esc(reasonText(c.reason)) + '</b></a>' },
      { key: 'type', label: 'Kind', type: 'enum', options: [{ value: 'image', label: 'image captcha' }, { value: 'checkbox', label: 'checkbox (live view)' }], value: (c) => (c.type === 'checkbox' ? 'checkbox' : 'image'),
        render: (c) => '<span' + tipA(typeTip(c.type)) + '>' + esc(typeText(c.type)) + '</span>' },
      { key: 'accountId', label: 'Account', type: 'text', render: (c) => '<span class="mono">' + esc(c.accountId || 'no account yet') + '</span>' },
      { key: 'createdAt', label: 'Since', type: 'datetime', storage: 'iso', render: (c) => esc(fmtTime(c.createdAt)), hideOn: 'phone' },
      { key: 'expiresAt', label: 'Left', type: 'datetime', storage: 'iso',
        render: (c) => { const l = leftText(c.expiresAt); return '<span class="left' + (l.soon ? ' soon' : '') + '">' + esc(l.text) + '</span>'; } },
    ];
  }
  async function load() {
    const r = await api('/challenges');
    if (!r.ok) { $('list-err').hidden = false; $('list-err').innerHTML = '<div class="banner bad">' + esc(r.status === 401 || r.status === 403 ? SIGN_IN_AGAIN : errText(r.data, r.status)) + '</div>'; return r; }
    $('list-err').hidden = true;
    rows = (r.data.challenges || []).filter((c) => c.state === 'pending' && c.ready !== false);
    if (typeof TK !== 'undefined') TK.navCount(rows.length);
    if (typeof TKTable === 'undefined') return r;
    if (table) { table.setRows(rows); return r; }
    table = TKTable.create($('list'), {
      id: 'cl',
      source: { rows: () => rows },
      columns: columns(),
      defaultSort: 'expiresAt',
      search: false,
      onRowClick: (c) => { if (typeof location !== 'undefined') location.href = '/ui/captcha/' + encodeURIComponent(c.id); },
      actions: (c) => '<a class="btn small primary" href="/ui/captcha/' + encodeURIComponent(c.id) + '">Solve →</a>',
      empty: 'No pending challenges. Nothing is waiting for you.',
    });
    return r;
  }
  load();
  const note = (t) => { $('list-note').hidden = false; $('list-note').innerHTML = '<div class="banner info">' + esc(t) + '</div>'; };
  poller(load, 15000, { onAuth: () => note(SIGN_IN_AGAIN), onTimeout: () => note(STOPPED_15) });
})();
`

export const CAPTCHA_LIST_HTML = shell({
  nav: 'captcha',
  title: 'Captchas',
  body: '<div id="list-note" hidden></div><div id="list-err" hidden></div><div id="list"><div class="empty">loading…</div></div>',
  css: POOL_CSS,
  js: JS,
  ownNavCount: true,
})
