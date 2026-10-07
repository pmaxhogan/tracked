// The tooltip component (src/ui/tip.ts): the escaping helpers, and TIP_JS run
// against a small fake DOM (hover, keyboard, touch long-press, context menu).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as vm from 'node:vm'
import { tipEscape, tipAttr, tipTerm, TIP_JS, TIP_CSS } from '../src/ui/tip'
import { shell } from '../src/ui/shell'
import { RUNTIME_JS } from '../src/ui/runtime'

describe('tip helpers', () => {
  it('escapes every character that could break out of an attribute or text node', () => {
    expect(tipEscape(`<b onclick="x">'&`)).toBe('&lt;b onclick=&quot;x&quot;&gt;&#39;&amp;')
    expect(tipEscape(null)).toBe('')
    expect(tipEscape(undefined)).toBe('')
    expect(tipEscape(42)).toBe('42')
  })
  it('tipAttr emits a leading space, escapes, trims and drops empty text', () => {
    expect(tipAttr('Does a thing')).toBe(' data-tip="Does a thing"')
    expect(tipAttr('  padded  ')).toBe(' data-tip="padded"')
    expect(tipAttr('say "hi" <now>')).toBe(' data-tip="say &quot;hi&quot; &lt;now&gt;"')
    expect(tipAttr('')).toBe('')
    expect(tipAttr('   ')).toBe('')
    expect(tipAttr(null)).toBe('')
    expect(tipAttr(undefined)).toBe('')
  })
  it('a hostile tooltip text cannot add an attribute or close the tag', () => {
    const html = `<button${tipAttr('x" onmouseover="alert(1)')}>Go</button>`
    expect(html).toBe('<button data-tip="x&quot; onmouseover=&quot;alert(1)">Go</button>')
    expect(html).not.toContain('" onmouseover=')
    expect(html.match(/"/g)).toHaveLength(2) // only the data-tip value's own quotes
  })
  it('tipTerm wraps non-interactive text with the dotted-underline class; the CSS gives only that class an underline', () => {
    expect(tipTerm('pending <1>', 'Not done yet')).toBe('<span class="tip-term" data-tip="Not done yet">pending &lt;1&gt;</span>')
    expect(TIP_CSS).toMatch(/\.tip-term\s*\{[^}]*underline dotted/)
    // Nothing that carries data-tip gets an underline by default.
    expect(TIP_CSS).not.toMatch(/\[data-tip\]\s*\{[^}]*underline/)
  })
  it('the runtime TK.tip matches tipAttr, and the shell ships the component', () => {
    const c: Record<string, unknown> = {}
    vm.createContext(c)
    vm.runInContext(RUNTIME_JS, c)
    const TK = vm.runInContext('TK', c) as { tip: (t: unknown) => string; tipTerm: (l: string, t: string) => string }
    for (const t of ['Does a thing', ' padded ', 'say "hi" <now> & \'x\'', '', null, undefined]) expect(TK.tip(t)).toBe(tipAttr(t as string))
    expect(TK.tipTerm('a<b', 'c"d')).toBe(tipTerm('a<b', 'c"d'))
    const html = shell({ nav: 'home', title: 'Home', body: '' })
    expect(html).not.toContain('id="tk-tip"') // created lazily, not in the markup
    expect(html).toContain('.tk-tip {')
    expect(html).toContain("'tk-tip'")
  })
})

// ── a fake DOM, just enough for TIP_JS ──
type Handler = (e: any) => void
class FakeEl {
  attrs = new Map<string, string>()
  parent: FakeEl | null = null
  children: FakeEl[] = []
  className = ''
  id = ''
  popover: string | null = null
  popoverOpen = false
  nodeType = 1
  textContent = ''
  style: Record<string, any> = { setProperty() {} }
  rect = { left: 100, top: 100, right: 160, bottom: 120, width: 60, height: 20 }
  constructor(public tag = 'div') {}
  get isConnected() { let n: FakeEl | null = this; while (n) { if (n.tag === 'body') return true; n = n.parent } return false }
  get parentElement() { return this.parent }
  get offsetWidth() { return 120 }
  get offsetHeight() { return 30 }
  get classList() {
    const self = this
    return {
      add(c: string) { if (!self.className.split(' ').includes(c)) self.className = (self.className + ' ' + c).trim() },
      remove(c: string) { self.className = self.className.split(' ').filter((x) => x && x !== c).join(' ') },
      contains(c: string) { return self.className.split(' ').includes(c) },
    }
  }
  setAttribute(k: string, v: string) { this.attrs.set(k, String(v)); if (k === 'popover') this.popover = String(v) }
  getAttribute(k: string) { return this.attrs.has(k) ? this.attrs.get(k)! : null }
  hasAttribute(k: string) { return this.attrs.has(k) }
  removeAttribute(k: string) { this.attrs.delete(k) }
  closest(sel: string) {
    const m = /^\[([a-z-]+)\]$/.exec(sel)
    let n: FakeEl | null = this
    while (n) { if (m && n.hasAttribute(m[1]!)) return n; n = n.parent }
    return null
  }
  matches(sel: string) { return sel === ':popover-open' ? this.popoverOpen : sel === ':focus-visible' }
  showPopover() { this.popoverOpen = true }
  hidePopover() { this.popoverOpen = false }
  getBoundingClientRect() { return this.rect }
  appendChild(c: FakeEl) { c.parent = this; this.children.push(c); return c }
  querySelector() { return null }
  contains(o: FakeEl | null) { let n: FakeEl | null = o; while (n) { if (n === this) return true; n = n.parent } return false }
}

function makeDom(opts: { hoverNone: boolean }) {
  const body = new FakeEl('body')
  const listeners: Record<string, Handler[]> = {}
  const wlisteners: Record<string, Handler[]> = {}
  const document = {
    body,
    documentElement: { clientWidth: 1000, clientHeight: 800 },
    createElement: (t: string) => new FakeEl(t),
    addEventListener: (t: string, f: Handler) => { (listeners[t] ||= []).push(f) },
  }
  const window = {
    matchMedia: (q: string) => ({ matches: q.includes('hover: none') ? opts.hoverNone : false }),
    addEventListener: (t: string, f: Handler) => { (wlisteners[t] ||= []).push(f) },
  }
  const ctx: Record<string, unknown> = {
    document, window, getComputedStyle: () => ({ display: 'block' }),
    setTimeout: (...a: unknown[]) => (globalThis.setTimeout as any)(...a),
    clearTimeout: (...a: unknown[]) => (globalThis.clearTimeout as any)(...a),
    setInterval: (...a: unknown[]) => (globalThis.setInterval as any)(...a),
    clearInterval: (...a: unknown[]) => (globalThis.clearInterval as any)(...a),
    Date, Math,
  }
  vm.createContext(ctx)
  vm.runInContext(TIP_JS, ctx)
  const fire = (type: string, target: FakeEl | null, extra: Record<string, unknown> = {}) => {
    const e: any = { type, target, defaultPrevented: false, stopped: false, preventDefault() { e.defaultPrevented = true }, stopPropagation() { e.stopped = true }, ...extra }
    for (const f of listeners[type] || []) f(e)
    return e
  }
  const wfire = (type: string) => { for (const f of wlisteners[type] || []) f({ type }) }
  const tipEl = () => body.children.find((c) => c.id === 'tk-tip') || null
  const add = (tag: string, tip: string | null) => { const el = new FakeEl(tag); if (tip != null) el.setAttribute('data-tip', tip); body.appendChild(el); return el }
  return { body, fire, wfire, tipEl, add }
}

describe('TIP_JS behaviour', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('does nothing in the pool pages stub DOM (no window / no document.body)', () => {
    const noWindow = vm.createContext({ document: { body: {}, addEventListener() { throw new Error('should not be reached') } } })
    expect(() => vm.runInContext(TIP_JS, noWindow)).not.toThrow()
    const noBody = vm.createContext({ window: {}, document: { addEventListener() { throw new Error('should not be reached') } } })
    expect(() => vm.runInContext(TIP_JS, noBody)).not.toThrow()
  })

  it('a mouse hover shows the tooltip after a short delay, wires aria-describedby, and leaving hides it', () => {
    const d = makeDom({ hoverNone: false })
    const b = d.add('button', 'Syncs this DJ')
    d.fire('pointerover', b, { pointerType: 'mouse', relatedTarget: null })
    expect(d.tipEl()).toBeNull()
    vi.advanceTimersByTime(399)
    expect(d.tipEl()).toBeNull()
    vi.advanceTimersByTime(2)
    const t = d.tipEl()!
    expect(t.textContent).toBe('Syncs this DJ')
    expect(t.getAttribute('role')).toBe('tooltip')
    expect(t.getAttribute('popover')).toBe('manual')
    expect(t.popoverOpen).toBe(true)
    expect(t.classList.contains('on')).toBe(true)
    expect(b.getAttribute('aria-describedby')).toBe('tk-tip')
    d.fire('pointerout', b, { pointerType: 'mouse', relatedTarget: null })
    vi.advanceTimersByTime(100)
    expect(t.popoverOpen).toBe(false)
    expect(t.classList.contains('on')).toBe(false)
    expect(b.hasAttribute('aria-describedby')).toBe(false)
  })

  it('moving straight to another tipped element shows its tooltip at once; Escape and scroll hide it', () => {
    const d = makeDom({ hoverNone: false })
    const a = d.add('button', 'First')
    const b = d.add('button', 'Second')
    d.fire('pointerover', a, { pointerType: 'mouse' })
    vi.advanceTimersByTime(450)
    d.fire('pointerout', a, { pointerType: 'mouse', relatedTarget: b })
    d.fire('pointerover', b, { pointerType: 'mouse' })
    expect(d.tipEl()!.textContent).toBe('Second')
    d.fire('keydown', null, { key: 'Escape' })
    expect(d.tipEl()!.popoverOpen).toBe(false)
    d.fire('pointerover', b, { pointerType: 'mouse' })
    expect(d.tipEl()!.popoverOpen).toBe(true)
    d.wfire('scroll')
    expect(d.tipEl()!.popoverOpen).toBe(false)
  })

  it('keyboard focus (focus-visible) shows it at once and blur hides it', () => {
    const d = makeDom({ hoverNone: false })
    const b = d.add('button', 'Focus me')
    d.fire('focusin', b)
    expect(d.tipEl()!.textContent).toBe('Focus me')
    d.fire('focusout', b)
    expect(d.tipEl()!.popoverOpen).toBe(false)
  })

  it('elements without data-tip, or with an empty one, never show anything', () => {
    const d = makeDom({ hoverNone: false })
    const plain = d.add('button', null)
    const empty = d.add('button', '')
    d.fire('pointerover', plain, { pointerType: 'mouse' })
    d.fire('pointerover', empty, { pointerType: 'mouse' })
    vi.advanceTimersByTime(1000)
    expect(d.tipEl()).toBeNull()
  })

  it('touch-only: press and hold shows it, suppresses the context menu on that element only, and swallows the release click', () => {
    const d = makeDom({ hoverNone: true })
    const b = d.add('button', 'Hold me')
    const other = d.add('button', null)
    d.fire('pointerdown', b, { pointerType: 'touch', clientX: 10, clientY: 10 })
    vi.advanceTimersByTime(400)
    expect(d.tipEl()).toBeNull()
    vi.advanceTimersByTime(100)
    expect(d.tipEl()!.textContent).toBe('Hold me')
    expect(d.tipEl()!.popoverOpen).toBe(true)
    // The browser then asks for the context menu: it is cancelled for the tipped element, not for others.
    expect(d.fire('contextmenu', b).defaultPrevented).toBe(true)
    expect(d.fire('contextmenu', other).defaultPrevented).toBe(false)
    d.fire('pointerup', b, { pointerType: 'touch' })
    const click = d.fire('click', b)
    expect(click.defaultPrevented).toBe(true)
    expect(click.stopped).toBe(true)
    // The next click is an ordinary one.
    const again = d.fire('click', b)
    expect(again.defaultPrevented).toBe(false)
    expect(again.stopped).toBe(false)
  })

  it('touch-only: a quick tap is an ordinary tap, and a tap elsewhere dismisses an open tooltip', () => {
    const d = makeDom({ hoverNone: true })
    const b = d.add('button', 'Hold me')
    const other = d.add('div', null)
    d.fire('pointerdown', b, { pointerType: 'touch', clientX: 5, clientY: 5 })
    vi.advanceTimersByTime(100)
    d.fire('pointerup', b, { pointerType: 'touch' })
    vi.advanceTimersByTime(1000)
    expect(d.tipEl()).toBeNull()
    expect(d.fire('click', b).defaultPrevented).toBe(false)
    // Hold, then tap elsewhere.
    d.fire('pointerdown', b, { pointerType: 'touch', clientX: 5, clientY: 5 })
    vi.advanceTimersByTime(500)
    expect(d.tipEl()!.popoverOpen).toBe(true)
    d.fire('pointerup', b, { pointerType: 'touch' })
    d.fire('pointerdown', other, { pointerType: 'touch', clientX: 300, clientY: 300 })
    expect(d.tipEl()!.popoverOpen).toBe(false)
  })

  it('touch-only: moving the finger cancels the long-press', () => {
    const d = makeDom({ hoverNone: true })
    const b = d.add('button', 'Hold me')
    d.fire('pointerdown', b, { pointerType: 'touch', clientX: 5, clientY: 5 })
    d.fire('pointermove', b, { pointerType: 'touch', clientX: 60, clientY: 5 })
    vi.advanceTimersByTime(1000)
    expect(d.tipEl()).toBeNull()
  })

  it('with a hover-capable pointer the context menu is never touched, even on a tipped element with its tooltip open', () => {
    const d = makeDom({ hoverNone: false })
    const b = d.add('button', 'Menu stays')
    d.fire('pointerover', b, { pointerType: 'mouse' })
    vi.advanceTimersByTime(500)
    expect(d.tipEl()!.popoverOpen).toBe(true)
    expect(d.fire('contextmenu', b).defaultPrevented).toBe(false)
    // A touch hold on a hybrid device (a hover-capable primary pointer) does not turn into a tooltip either.
    d.fire('keydown', null, { key: 'Escape' })
    d.fire('pointerdown', b, { pointerType: 'touch', clientX: 5, clientY: 5 })
    vi.advanceTimersByTime(1000)
    expect(d.tipEl()!.popoverOpen).toBe(false)
    expect(d.fire('contextmenu', b).defaultPrevented).toBe(false)
  })

  it('touch-only: hover events that touch emulates are ignored', () => {
    const d = makeDom({ hoverNone: true })
    const b = d.add('button', 'Hold me')
    d.fire('pointerover', b, { pointerType: 'touch' })
    vi.advanceTimersByTime(1000)
    expect(d.tipEl()).toBeNull()
  })
})
