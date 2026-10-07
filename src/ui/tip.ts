// Custom tooltips for the admin UI. A tooltip is just an attribute:
//   <button data-tip="What this does">...</button>
// Server-side, build it with tipAttr(); in page scripts use TK.tip(text) (same
// output). tipTerm() / TK.tipTerm() wrap a word in non-interactive text and give
// it the one visual hint (dotted underline); buttons, links and chips get none.
//
// TIP_JS is the behaviour (one delegated listener set, no per-element work):
//   mouse: hover after a short delay, immediate when moving between tips;
//   keyboard: on :focus-visible; Escape, scroll and resize hide it;
//   touch-only devices (hover: none): press and hold ~450 ms shows it, the
//   long-press context menu is suppressed for that element only, the click the
//   release would cause is swallowed, a tap elsewhere dismisses. With a
//   hover-capable pointer the context menu is never touched.
// It renders into the top layer (popover="manual") so it also shows above
// open <dialog>s. It is guarded for the pool pages' stub DOM (no window or
// document.body there: the script returns at once).

/** HTML-escapes text for an attribute or text node. */
export function tipEscape(s: unknown): string {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** ` data-tip="..."` (leading space), escaped; empty string for empty text. */
export function tipAttr(text: string | null | undefined): string {
  const t = text == null ? '' : String(text).trim()
  return t ? ` data-tip="${tipEscape(t)}"` : ''
}

/** Inline text with a tooltip and the dotted-underline hint. Only for non-interactive text. */
export function tipTerm(label: string, text: string): string {
  return `<span class="tip-term"${tipAttr(text)}>${tipEscape(label)}</span>`
}

export const TIP_CSS = /* css */ `
/* ── tooltips (data-tip) ── */
.tk-tip { position: fixed; inset: auto; margin: 0; z-index: 100; max-width: min(20rem, calc(100vw - 16px)); padding: 7px 10px; border: 1px solid var(--line-strong); border-radius: var(--r-tile); background: var(--elev); color: var(--fg); box-shadow: var(--shadow-float); font: 500 var(--fs-xs)/1.45 var(--sans); text-align: left; white-space: pre-line; overflow-wrap: anywhere; pointer-events: none; overflow: visible; opacity: 0; transform: translateY(2px); transition: opacity .12s ease, transform .12s ease; }
.tk-tip.on { opacity: 1; transform: none; }
.tk-tip::after { content: ""; position: absolute; left: var(--ax, 50%); width: 8px; height: 8px; margin-left: -4px; background: var(--elev); border: 1px solid var(--line-strong); transform: rotate(45deg); }
.tk-tip[data-side=top]::after { bottom: -5px; border-top: 0; border-left: 0; }
.tk-tip[data-side=bottom]::after { top: -5px; border-bottom: 0; border-right: 0; }
@media (prefers-reduced-motion: reduce) { .tk-tip { transition: none; } }
.tip-term { text-decoration: underline dotted var(--subtle); text-underline-offset: 3px; cursor: help; }
@media (hover: none) { [data-tip] { -webkit-touch-callout: none; } }
`

export const TIP_JS = /* js */ `
(() => {
  if (typeof document === 'undefined' || !document.body || typeof document.addEventListener !== 'function' || typeof window === 'undefined') return;
  const HOVER_DELAY = 400, LONG_PRESS = 450, MOVE_SLOP = 10, TOUCH_HIDE = 6000;
  let tipEl = null, anchor = null, showTimer = 0, pressTimer = 0, hideTimer = 0, watch = 0, lastShownAt = 0;
  let press = null, blockClick = null;

  const touchOnly = () => { try { return !!(window.matchMedia && window.matchMedia('(hover: none)').matches); } catch (e) { return false; } };
  const closestTip = (t) => {
    const el = t && t.nodeType === 3 ? t.parentElement : t;
    const a = el && el.closest ? el.closest('[data-tip]') : null;
    return a && a.getAttribute('data-tip') ? a : null;
  };
  // data-tip-rail: only worth showing while the visible label is collapsed (the icon rail).
  const suppressed = (a) => {
    if (!a.hasAttribute('data-tip-rail')) return false;
    const l = a.querySelector('.lbl');
    return !!(l && getComputedStyle(l).display !== 'none' && l.getBoundingClientRect().width > 4);
  };
  const ensure = () => {
    if (tipEl) return tipEl;
    tipEl = document.createElement('div');
    tipEl.className = 'tk-tip';
    tipEl.id = 'tk-tip';
    tipEl.setAttribute('role', 'tooltip');
    if ('popover' in tipEl) tipEl.setAttribute('popover', 'manual'); else { tipEl.className += ' fallback'; tipEl.style.display = 'none'; }
    document.body.appendChild(tipEl);
    return tipEl;
  };

  function hide() {
    clearTimeout(showTimer); clearTimeout(hideTimer); showTimer = hideTimer = 0;
    clearInterval(watch); watch = 0;
    if (anchor) { try { if (anchor.getAttribute('aria-describedby') === 'tk-tip') anchor.removeAttribute('aria-describedby'); } catch (e) {} }
    anchor = null;
    if (!tipEl) return;
    tipEl.classList.remove('on');
    try { if (tipEl.matches(':popover-open')) tipEl.hidePopover(); } catch (e) {}
    if (tipEl.classList.contains('fallback')) tipEl.style.display = 'none';
  }

  function place(a) {
    const t = tipEl, r = a.getBoundingClientRect(), m = 8, gap = 9;
    t.style.left = '0px'; t.style.top = '0px';
    const w = t.offsetWidth, h = t.offsetHeight, vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    let side = 'top', y = r.top - h - gap;
    if (y < m && r.bottom + gap + h <= vh - m) { side = 'bottom'; y = r.bottom + gap; }
    else if (y < m) { y = Math.max(m, Math.min(vh - h - m, y)); }
    const cx = r.left + r.width / 2;
    const x = Math.max(m, Math.min(vw - w - m, cx - w / 2));
    t.style.left = Math.round(x) + 'px'; t.style.top = Math.round(y) + 'px';
    t.style.setProperty('--ax', Math.round(Math.max(14, Math.min(w - 14, cx - x))) + 'px');
    t.setAttribute('data-side', side);
  }

  function show(a, autoHideMs) {
    const text = a.getAttribute('data-tip');
    if (!text || !a.isConnected || suppressed(a)) return;
    const t = ensure();
    clearTimeout(hideTimer); hideTimer = 0;
    if (anchor && anchor !== a && anchor.getAttribute('aria-describedby') === 'tk-tip') anchor.removeAttribute('aria-describedby');
    anchor = a;
    t.textContent = text;
    if (t.classList.contains('fallback')) t.style.display = 'block';
    else { try { if (t.matches(':popover-open')) t.hidePopover(); t.showPopover(); } catch (e) {} }
    place(a);
    a.setAttribute('aria-describedby', 'tk-tip');
    t.classList.add('on');
    lastShownAt = Date.now();
    clearInterval(watch);
    watch = setInterval(() => { if (!anchor || !anchor.isConnected) hide(); }, 700);
    if (autoHideMs) hideTimer = setTimeout(hide, autoHideMs);
  }

  // ── mouse / pen hover ──
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const a = closestTip(e.target);
    if (!a) return;
    if (a === anchor) { clearTimeout(hideTimer); hideTimer = 0; return; }
    clearTimeout(showTimer);
    const warm = (tipEl && tipEl.classList.contains('on')) || Date.now() - lastShownAt < 300;
    if (warm) show(a); else showTimer = setTimeout(() => show(a), HOVER_DELAY);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'touch') return;
    const a = closestTip(e.target);
    if (!a) return;
    if (closestTip(e.relatedTarget) === a) return;
    clearTimeout(showTimer); showTimer = 0;
    if (a === anchor) { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 60); }
  });

  // ── keyboard focus ──
  document.addEventListener('focusin', (e) => {
    const a = closestTip(e.target);
    if (!a) return;
    let vis = true; try { vis = a.matches(':focus-visible'); } catch (x) {}
    if (vis) show(a);
  });
  document.addEventListener('focusout', (e) => { if (anchor && closestTip(e.target) === anchor) hide(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  window.addEventListener('scroll', () => { if (anchor) hide(); }, true);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);

  // ── touch: press and hold ──
  document.addEventListener('pointerdown', (e) => {
    blockClick = null;
    if (e.pointerType !== 'touch') { hide(); return; }
    const a = closestTip(e.target);
    if (!a) { hide(); return; }
    if (!touchOnly()) return;
    hide();
    press = { a, x: e.clientX, y: e.clientY, fired: false };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      if (!press) return;
      press.fired = true; blockClick = a;
      show(a, TOUCH_HIDE);
      try { if (navigator.vibrate) navigator.vibrate(10); } catch (x) {}
    }, LONG_PRESS);
  });
  document.addEventListener('pointermove', (e) => {
    if (press && !press.fired && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_SLOP) { clearTimeout(pressTimer); press = null; }
  });
  const endPress = () => { clearTimeout(pressTimer); press = null; };
  document.addEventListener('pointerup', endPress);
  document.addEventListener('pointercancel', endPress);
  // A hold on a touch-only device must not open the context menu; a mouse never loses its menu.
  document.addEventListener('contextmenu', (e) => {
    if (!touchOnly()) return;
    const a = closestTip(e.target);
    if (a && (press || blockClick === a || (anchor === a && Date.now() - lastShownAt < 1500))) e.preventDefault();
  });
  // The click that follows the release of a long press is not a tap.
  document.addEventListener('click', (e) => {
    if (blockClick && blockClick.contains(e.target)) { e.preventDefault(); e.stopPropagation(); }
    blockClick = null;
  }, true);
})();
`
