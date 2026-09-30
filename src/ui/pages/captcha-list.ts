// Captchas page: every pending challenge, polled every 15 s.
import { shell } from '../shell'
import { POOL_CSS, COMMON_JS } from './pool-common'

const JS = /* js */ `
(() => {
${COMMON_JS}
  async function load() {
    const r = await api('/challenges');
    if (!r.ok) { $('list').innerHTML = '<div class="banner bad">' + esc(r.status === 401 || r.status === 403 ? SIGN_IN_AGAIN : errText(r.data, r.status)) + '</div>'; return r; }
    const open = (r.data.challenges || []).filter((c) => c.state === 'pending' && c.ready !== false);
    if (typeof TK !== 'undefined') TK.navCount(open.length);
    if (!open.length) { $('list').innerHTML = '<div class="empty">No pending challenges. Nothing is waiting for you.</div>'; return r; }
    $('list').innerHTML = '<ul class="plain">' + open.map((c) => {
      const l = leftText(c.expiresAt);
      return '<li><a class="open" href="/ui/captcha/' + encodeURIComponent(c.id) + '">' +
        '<div class="row"><b>' + esc(reasonText(c.reason)) + '</b><span class="spacer"></span><span class="left' + (l.soon ? ' soon' : '') + '">' + esc(l.text) + '</span></div>' +
        '<div class="muted sub">' + esc(c.accountId || 'no account yet') + ' · ' + esc(typeText(c.type)) + ' · since ' + esc(fmtTime(c.createdAt)) + '</div>' +
        '<div class="go">Solve →</div></a></li>';
    }).join('') + '</ul>';
    return r;
  }
  load();
  const note = (t) => { const p = document.createElement('div'); p.className = 'banner info'; p.textContent = t; $('list').prepend(p); };
  poller(load, 15000, { onAuth: () => note(SIGN_IN_AGAIN), onTimeout: () => note(STOPPED_15) });
})();
`

export const CAPTCHA_LIST_HTML = shell({
  nav: 'captcha',
  title: 'Captchas',
  body: '<div id="list"><div class="empty">loading…</div></div>',
  css: POOL_CSS,
  js: JS,
  ownNavCount: true,
})
