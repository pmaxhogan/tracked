// Captcha page (what a push notification opens): one challenge, image + answer box or the live view.
import { shell } from '../shell'
import { POOL_CSS, COMMON_JS, CAPTCHA_JS } from './pool-common'

/** The page a push notification opens. `id` is validated against ID_RE before it gets here. */
export function captchaPageHtml(id: string): string {
  const js = /* js */ `
(() => {
${COMMON_JS}
${CAPTCHA_JS}
  const ID = ${JSON.stringify(id)};
  let ch = null, widget = null, finished = false, timer = null, watch = null;

  function renderHead() {
    const l = leftText(ch.expiresAt);
    $('head').innerHTML =
      '<div class="row"><b class="mono">' + esc(ch.accountId || 'new account') + '</b><span class="badge info">' + esc(typeText(ch.type)) + '</span><span class="spacer"></span><span id="left" class="left' + (l.soon ? ' soon' : '') + '">' + esc(l.text) + '</span></div>' +
      '<div class="muted sub" style="margin-top:var(--sp-1)">' + esc(reasonText(ch.reason)) + ' · since ' + esc(fmtTime(ch.createdAt)) + '</div>';
  }
  function tick() {
    const el = $('left');
    if (!el || !ch) return;
    const l = leftText(ch.expiresAt);
    el.textContent = l.text; el.className = 'left' + (l.soon ? ' soon' : '');
  }
  function finish(kind, text) {
    finished = true;
    if (timer) clearInterval(timer);
    if (watch) watch.stop();
    if (widget) widget.disable();
    if (kind !== 'ok') $('widget').innerHTML = '';
    $('state').innerHTML = '<div class="banner ' + kind + '">' + esc(text) + '</div><p><a href="/ui/captcha">Other pending captchas</a> · <a href="/ui/pool">Pool</a></p>';
  }
  function applyState() {
    if (ch.state === 'solved') finish('ok', '✓ Solved. The pool browser carries on.');
    else if (ch.state === 'expired') finish('bad', 'This challenge expired. The account rests for 6 hours; a new challenge will come if it is needed.');
    else if (ch.state === 'failed') finish('bad', 'This challenge was closed by the pool' + (ch.error ? ' (' + ch.error.replace(/_/g, ' ') + ')' : '') + '.');
  }
  async function refresh(first) {
    if (finished) return;
    const r = await api('/challenges/' + encodeURIComponent(ID));
    if (!r.ok) {
      if (r.status === 404) { if (first) $('head').innerHTML = ''; finish('bad', 'This challenge is gone: it was solved, or closed after 2 hours.'); }
      else if (r.status === 401 || r.status === 403) { $('state').innerHTML = '<div class="banner bad">' + esc(SIGN_IN_AGAIN) + '</div>'; }
      else if (first) { $('head').innerHTML = '<span class="error">' + esc(errText(r.data, r.status)) + '</span> <button type="button" class="btn small" id="again">Try again</button>'; $('again').onclick = () => refresh(true); }
      return r;
    }
    ch = r.data.challenge;
    renderHead();
    if (ch.state !== 'pending') { applyState(); return r; }
    if (ch.ready === false) { $('widget').innerHTML = '<p class="muted">Nothing to answer yet: the pool has not met a captcha on this page. This page keeps checking.</p>'; return r; }
    if (!widget) {
      $('widget').innerHTML = '';
      widget = mountCaptcha($('widget'), ch, { onOutcome: (o) => { if (o === 'solved') { ch.state = 'solved'; applyState(); } else if (o === 'expired') { ch.state = 'expired'; applyState(); } else if (o === 'accepted' && watch) setTimeout(() => watch.now(), 1500); } });
    }
    return r;
  }
  (async () => {
    await refresh(true);
    if (finished) return;
    // The checkbox wall clears by itself once clicked, and tlpool notices: look every 3 s.
    watch = poller(() => refresh(false), ch && ch.type === 'checkbox' ? 3000 : 4000, {
      onAuth: () => { $('state').innerHTML = '<div class="banner bad">' + esc(SIGN_IN_AGAIN) + '</div>'; },
      onTimeout: () => { if (!finished) $('state').innerHTML = '<div class="banner info">' + esc(STOPPED_15) + '</div>'; },
    });
  })();
  timer = setInterval(tick, 1000);
})();
`
  return shell({
    nav: 'captcha',
    title: 'Captcha',
    width: 'narrow',
    body: '<div id="head" class="tk-card"><span class="muted">loading…</span></div><div id="state"></div><div id="widget"></div>',
    css: POOL_CSS,
    js,
    ownNavCount: true,
  })
}
