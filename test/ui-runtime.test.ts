import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { RUNTIME_JS, THEME_BOOT_JS } from '../src/ui/runtime'

function ctx(extra: Record<string, unknown> = {}) {
  const els = new Map<string, any>()
  const handlers: Array<{ type: string; fn: () => unknown }> = []
  const el = (): any => ({ open: false, innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, className: '', dataset: {}, style: {},
    addEventListener() {}, showModal() { this.open = true }, close() { this.open = false }, querySelector: () => null, querySelectorAll: () => [] })
  const document = {
    hidden: false,
    getElementById: (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id))),
    querySelector: () => null,
    addEventListener(type: string, fn: () => unknown) { handlers.push({ type, fn }) },
  }
  const c = vm.createContext({ document, console, setTimeout, clearTimeout, Date, JSON, URL, ...extra })
  return { c, els, document, handlers }
}
const settle = () => new Promise((r) => setImmediate(r))

describe('shared scripts in the minimal pool stub', () => {
  it('run without window, navigator, localStorage, location, history or body', () => {
    const { c } = ctx()
    expect(() => vm.runInContext(THEME_BOOT_JS, c)).not.toThrow()
    expect(() => vm.runInContext(RUNTIME_JS, c)).not.toThrow()
    expect(vm.runInContext('typeof TK.api.post', c)).toBe('function')
  })
  it('the theme survives a throwing localStorage', () => {
    const throwing = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
    const root = { dataset: {} as Record<string, string> }
    const { c } = ctx({ localStorage: throwing })
    ;(c as any).document.documentElement = root
    expect(() => vm.runInContext(THEME_BOOT_JS + RUNTIME_JS + ';TK.theme.set("dark")', c)).not.toThrow()
    expect(root.dataset.theme).toBe('dark')
  })
  it('boot applies a stored manual theme and leaves "system" to the media query', () => {
    for (const [stored, want] of [['light', 'light'], ['dark', 'dark'], ['system', undefined], [null, undefined]] as const) {
      const root = { dataset: {} as Record<string, string> }
      const { c } = ctx({ localStorage: { getItem: () => stored, setItem() {} } })
      ;(c as any).document.documentElement = root
      vm.runInContext(THEME_BOOT_JS, c)
      expect(root.dataset.theme).toBe(want)
    }
  })
  it('parse as plain scripts', () => {
    expect(() => new vm.Script(RUNTIME_JS)).not.toThrow()
    expect(() => new vm.Script(THEME_BOOT_JS)).not.toThrow()
  })
  it('declare only TK: no timers, fetches or pool-page names at load', () => {
    let timers = 0; let fetches = 0
    const { c } = ctx({ setTimeout: () => (timers++, 0), fetch: async () => (fetches++, new Response('{}')) })
    vm.runInContext(THEME_BOOT_JS + RUNTIME_JS, c)
    expect(timers).toBe(0)
    expect(fetches).toBe(0)
    for (const name of ['$', 'esc', 'api', 'jsonInit', 'poller', 'errText']) {
      expect(vm.runInContext(`typeof ${name}`, c)).toBe('undefined')
    }
    expect(RUNTIME_JS).not.toMatch(/quiet/i)
    expect(THEME_BOOT_JS).not.toMatch(/quiet/i)
  })
})

describe('TK basics', () => {
  it('esc escapes all five characters and tolerates null', () => {
    const { c } = ctx()
    vm.runInContext(RUNTIME_JS, c)
    ;(c as any).s = '<a href="x">&\''
    expect(vm.runInContext('TK.esc(s)', c)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
    expect(vm.runInContext('TK.esc(null)', c)).toBe('')
  })
  it('safeHref keeps only http(s)', () => {
    const { c } = ctx()
    vm.runInContext(RUNTIME_JS, c)
    expect(vm.runInContext("TK.safeHref('https://x.example/a')", c)).toBe('https://x.example/a')
    expect(vm.runInContext("TK.safeHref('HTTP://x')", c)).toBe('HTTP://x')
    expect(vm.runInContext("TK.safeHref('javascript:alert(1)')", c)).toBe(null)
    expect(vm.runInContext('TK.safeHref(null)', c)).toBe(null)
  })
  it('navCount sets both badges and hides them at zero', () => {
    const { c, els } = ctx()
    vm.runInContext(RUNTIME_JS, c)
    vm.runInContext('TK.navCount(3)', c)
    expect(els.get('nav-count-captcha')).toMatchObject({ textContent: '3', hidden: false })
    expect(els.get('tab-count-captcha')).toMatchObject({ textContent: '3', hidden: false })
    vm.runInContext('TK.navCount(0)', c)
    expect(els.get('nav-count-captcha').hidden).toBe(true)
    expect(els.get('tab-count-captcha').hidden).toBe(true)
  })
  it('toast falls back to textContent without createElement', () => {
    const { c, els } = ctx()
    vm.runInContext(RUNTIME_JS, c)
    vm.runInContext("TK.toast('Saved')", c)
    expect(els.get('tk-toasts').textContent).toBe('Saved')
  })
  it('toast builds ok and bad toasts with createElement', () => {
    const made: any[] = []
    const node = (tag: string) => { const n: any = { tag, children: [] as any[], textContent: '', className: '', parentNode: null,
      appendChild(ch: any) { ch.parentNode = n; n.children.push(ch) }, removeChild(ch: any) { n.children = n.children.filter((x: any) => x !== ch); ch.parentNode = null },
      setAttribute(k: string, v: string) { n[k] = v } }; made.push(n); return n }
    const timers: Array<{ fn: () => void; ms: number }> = []
    const { c, els } = ctx({ setTimeout: (fn: () => void, ms: number) => (timers.push({ fn, ms }), 1) })
    const box = node('div'); els.set('tk-toasts', box)
    ;(c as any).document.createElement = node
    vm.runInContext(RUNTIME_JS, c)
    vm.runInContext("TK.toast('Saved')", c)
    expect(box.children[0]).toMatchObject({ className: 'toast ok' })
    expect(box.children[0].children[0].textContent).toBe('Saved')
    expect(timers.at(-1)!.ms).toBe(6000)
    timers.at(-1)!.fn()
    expect(box.children.length).toBe(0)
    vm.runInContext("TK.toast('Failed', 'bad', '<b>raw</b>')", c)
    const t = box.children[0]
    expect(t.className).toBe('toast bad')
    expect(t.children.map((x: any) => x.tag)).toEqual(['div', 'pre', 'button'])
    expect(t.children[1].textContent).toBe('<b>raw</b>')
    expect(timers.length).toBe(1)
    t.children[2].onclick()
    expect(box.children.length).toBe(0)
  })
  it('toast goes inside the topmost open dialog (one region, reused), else #tk-toasts', () => {
    const node = (tag: string) => { const n: any = { tag, children: [] as any[], attrs: {} as Record<string, string>, textContent: '', className: '', parentNode: null,
      appendChild(ch: any) { ch.parentNode = n; n.children.push(ch) }, removeChild(ch: any) { n.children = n.children.filter((x: any) => x !== ch); ch.parentNode = null },
      setAttribute(k: string, v: string) { n.attrs[k] = v },
      querySelector(sel: string) { return sel === '[data-tk-toasts]' ? n.children.find((x: any) => 'data-tk-toasts' in x.attrs) ?? null : null } }; return n }
    const { c, els } = ctx()
    const shellBox = node('div'); els.set('tk-toasts', shellBox)
    const below = node('dialog'), drawer = node('dialog')
    let open: any[] = []
    ;(c as any).document.createElement = node
    ;(c as any).document.querySelectorAll = (sel: string) => (sel === 'dialog[open]' ? open : [])
    vm.runInContext(RUNTIME_JS, c)
    vm.runInContext("TK.toast('Saved')", c)
    expect(shellBox.children.length).toBe(1)
    open = [below, drawer]
    vm.runInContext("TK.toast('retry failed (500)', 'bad')", c)
    vm.runInContext("TK.toast('again', 'bad')", c)
    expect(below.children.length).toBe(0)
    expect(drawer.children.length).toBe(1)
    const region = drawer.children[0]
    expect(region).toMatchObject({ className: 'tk-toasts' })
    expect(region.attrs['aria-live']).toBe('polite')
    expect(region.children.map((t: any) => t.children[0].textContent)).toEqual(['retry failed (500)', 'again'])
    expect(shellBox.children.length).toBe(1)
    open = []
    vm.runInContext("TK.toast('back')", c)
    expect(shellBox.children.length).toBe(2)
  })
  it('toast uses #tk-toasts when document.querySelector finds no dialog (pool stub)', () => {
    const node = (): any => { const n: any = { children: [] as any[], textContent: '', className: '', appendChild(ch: any) { n.children.push(ch) }, setAttribute() {} }; return n }
    const { c, els } = ctx()
    const box = node(); els.set('tk-toasts', box)
    ;(c as any).document.createElement = node
    vm.runInContext(RUNTIME_JS, c)
    expect(() => vm.runInContext("TK.toast('x', 'bad')", c)).not.toThrow()
    expect(box.children.length).toBe(1)
  })
  it('ask resolves on yes, no and dialog close, and false without showModal', async () => {
    const { c, els } = ctx()
    vm.runInContext(RUNTIME_JS, c)
    let p = vm.runInContext("TK.ask('Delete it?', { yes: 'Delete', danger: true })", c)
    expect(els.get('tk-confirm-text').textContent).toBe('Delete it?')
    expect(els.get('tk-confirm-yes')).toMatchObject({ textContent: 'Delete', className: 'btn danger' })
    expect(els.get('tk-confirm').open).toBe(true)
    els.get('tk-confirm-yes').onclick()
    expect(await p).toBe(true)
    p = vm.runInContext("TK.ask('Go?')", c)
    expect(els.get('tk-confirm-yes')).toMatchObject({ textContent: 'Yes', className: 'btn primary' })
    expect(els.get('tk-confirm-no').textContent).toBe('Cancel')
    els.get('tk-confirm-no').onclick()
    expect(await p).toBe(false)
    p = vm.runInContext("TK.ask('Go?')", c)
    els.get('tk-confirm').onclose()
    expect(await p).toBe(false)
    els.get('tk-confirm').showModal = undefined
    expect(await vm.runInContext("TK.ask('Go?')", c)).toBe(false)
  })
  it('drawer opens with title and body, and closes', () => {
    const { c, els } = ctx()
    vm.runInContext(RUNTIME_JS, c)
    const body = vm.runInContext("TK.drawer.open('Set', '<p>hi</p>')", c)
    expect(els.get('tk-drawer-title').textContent).toBe('Set')
    expect(body).toBe(els.get('tk-drawer-body'))
    expect(body.innerHTML).toBe('<p>hi</p>')
    expect(els.get('tk-drawer').open).toBe(true)
    els.get('tk-drawer-close').onclick()
    expect(els.get('tk-drawer').open).toBe(false)
  })
  it('busy disables the button and restores it after fn settles', async () => {
    const { c } = ctx()
    vm.runInContext(RUNTIME_JS, c)
    const btn = { textContent: 'Save', disabled: false, dataset: {} as Record<string, string> }
    ;(c as any).btn = btn
    let seen: any = null
    ;(c as any).work = async () => { seen = { ...btn, dataset: { ...btn.dataset } }; throw new Error('x') }
    await expect(vm.runInContext("TK.busy(btn, 'Saving…', work)", c)).rejects.toThrow('x')
    expect(seen).toMatchObject({ textContent: 'Saving…', disabled: true, dataset: { busy: '1' } })
    expect(btn).toMatchObject({ textContent: 'Save', disabled: false })
    expect(btn.dataset.busy).toBeUndefined()
  })
  it('qs reads and writes the query string when location exists, else is inert', () => {
    const { c } = ctx()
    vm.runInContext(RUNTIME_JS, c)
    expect(vm.runInContext("TK.qs.get('q')", c)).toBe(null)
    expect(() => vm.runInContext("TK.qs.set({ q: 'x' })", c)).not.toThrow()
    const replaced: string[] = []
    const { c: c2 } = ctx({ URLSearchParams, location: { search: '?q=abc', pathname: '/ui/search' }, history: { replaceState: (_s: unknown, _t: string, u: string) => replaced.push(u) } })
    vm.runInContext(RUNTIME_JS, c2)
    expect(vm.runInContext("TK.qs.get('q')", c2)).toBe('abc')
    vm.runInContext("TK.qs.set({ q: 'a b', empty: '', none: null, n: 2 })", c2)
    vm.runInContext('TK.qs.set({})', c2)
    expect(replaced).toEqual(['/ui/search?q=a+b&n=2', '/ui/search'])
  })
  it('theme.get returns the stored value or system', () => {
    const { c } = ctx({ localStorage: { getItem: () => 'dark', setItem() {} } })
    vm.runInContext(RUNTIME_JS, c)
    expect(vm.runInContext('TK.theme.get()', c)).toBe('dark')
    const { c: c2 } = ctx()
    vm.runInContext(RUNTIME_JS, c2)
    expect(vm.runInContext('TK.theme.get()', c2)).toBe('system')
    const root = { dataset: { theme: 'dark' } as Record<string, string> }
    const stored: string[] = []
    const { c: c3 } = ctx({ localStorage: { getItem: () => null, setItem: (_k: string, v: string) => stored.push(v) } })
    ;(c3 as any).document.documentElement = root
    vm.runInContext(RUNTIME_JS + ';TK.theme.set("system")', c3)
    expect(root.dataset.theme).toBeUndefined()
    expect(stored).toEqual(['system'])
  })
})

describe('TK.api', () => {
  it('sends same-origin JSON with the method and content type in one literal', async () => {
    const calls: Array<[string, RequestInit]> = []
    const { c } = ctx({ fetch: async (u: string, i: RequestInit) => (calls.push([u, i]), new Response('{"ok":true}', { status: 200 })) })
    vm.runInContext(RUNTIME_JS, c)
    const r = await vm.runInContext("TK.api.post('/ui/api/add', { url: 'x' })", c)
    expect(r).toMatchObject({ ok: true, status: 200, data: { ok: true } })
    expect(calls[0]![1]).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{"url":"x"}' })
    await vm.runInContext("TK.api.post('/ui/api/x')", c)
    expect(calls[1]![1].body).toBe('{}')
    expect(RUNTIME_JS).toMatch(/\{ method: 'POST', headers: \{ 'content-type': 'application\/json' \}/)
  })
  it('put, del and get use their methods', async () => {
    const calls: Array<[string, RequestInit]> = []
    const { c } = ctx({ fetch: async (u: string, i: RequestInit) => (calls.push([u, i]), new Response(null, { status: 204 })) })
    vm.runInContext(RUNTIME_JS, c)
    expect(await vm.runInContext("TK.api.put('/a', { x: 1 })", c)).toMatchObject({ ok: true, status: 204, data: null, raw: '' })
    await vm.runInContext("TK.api.del('/b')", c)
    await vm.runInContext("TK.api.get('/c')", c)
    expect(calls.map(([u, i]) => [u, i.method])).toEqual([['/a', 'PUT'], ['/b', 'DELETE'], ['/c', undefined]])
    expect(calls[2]![1]).toEqual({ credentials: 'same-origin' })
  })
  it('turns a network error into status 0 and a non-JSON body into raw', async () => {
    const { c } = ctx({ fetch: async () => { throw new TypeError('offline') } })
    vm.runInContext(RUNTIME_JS, c)
    expect(await vm.runInContext("TK.api.get('/ui/api/list')", c)).toMatchObject({ ok: false, status: 0, data: { error: 'network' } })
    const { c: c2 } = ctx({ fetch: async () => new Response('Internal Server Error', { status: 500 }) })
    vm.runInContext(RUNTIME_JS, c2)
    expect(await vm.runInContext("TK.api.get('/x')", c2)).toMatchObject({ ok: false, status: 500, data: null, raw: 'Internal Server Error' })
  })
  it('errText maps known codes to plain text', () => {
    const { c } = ctx()
    vm.runInContext(RUNTIME_JS, c)
    expect(vm.runInContext("TK.errText({ data: { error: 'youtube_not_connected' } }, 'x')", c)).toMatch(/YouTube/)
    expect(vm.runInContext("TK.errText({ data: { error: 'e', message: 'Plain words' } }, 'x')", c)).toBe('Plain words')
    expect(vm.runInContext("TK.errText({ status: 502, data: null }, 'failed (502)')", c)).toBe('failed (502)')
    expect(vm.runInContext("TK.errText({ data: { error: 'odd_code' } }, 'x')", c)).toBe('odd_code')
    expect(vm.runInContext("TK.errText(null, 'fb')", c)).toBe('fb')
  })
})

describe('TK.poll', () => {
  it('backs off on 5xx, stops on 401 with onAuth, pauses while hidden', async () => {
    const timers: Array<{ fn: () => unknown; ms: number }> = []
    const { c, document, handlers } = ctx({ setTimeout: (fn: () => unknown, ms: number) => (timers.push({ fn, ms }), timers.length), clearTimeout() {} })
    vm.runInContext(RUNTIME_JS, c)
    // fn returns { status }, like an api() result (the pool poller's contract).
    let status = 503; let authed = 0; let runs = 0
    ;(c as any).fn = async () => (runs++, { status })
    ;(c as any).onAuth = () => { authed++ }
    vm.runInContext('TK.poll(fn, 20000, { onAuth })', c)
    expect(timers.at(-1)!.ms).toBe(20000)
    await timers.at(-1)!.fn(); expect(timers.at(-1)!.ms).toBe(40000)
    await timers.at(-1)!.fn(); expect(timers.at(-1)!.ms).toBe(60000)
    status = 401; const n = timers.length
    await timers.at(-1)!.fn(); expect(authed).toBe(1); expect(timers.length).toBe(n)

    // A fresh poller: hidden skips the run and schedules nothing; visible again runs once and reschedules.
    status = 200
    vm.runInContext('TK.poll(fn, 20000, {})', c)
    const vis = handlers.filter((h) => h.type === 'visibilitychange').at(-1)!
    const before = runs; const m = timers.length
    document.hidden = true
    await timers.at(-1)!.fn()
    expect(runs).toBe(before)
    expect(timers.length).toBe(m)
    document.hidden = false
    vis.fn(); await settle()
    expect(runs).toBe(before + 1)
    expect(timers.length).toBe(m + 1)
    expect(timers.at(-1)!.ms).toBe(20000)
  })
})

describe('TK.fmt', () => {
  it('keeps the old helpers', () => {
    const { c } = ctx()
    vm.runInContext(RUNTIME_JS, c)
    expect(vm.runInContext('TK.fmt.dur(90 * 60000)', c)).toBe('1 h 30 min')
    expect(vm.runInContext('TK.fmt.dur(5 * 60000)', c)).toBe('5 min')
    expect(vm.runInContext("TK.fmt.setLabel('https://www.1001tracklists.com/tracklist/abc/some_dj-set-name.html')", c)).toBe('some dj set name')
    expect(vm.runInContext("TK.fmt.setLabel('')", c)).toBe('(unknown set)')
    expect(vm.runInContext('TK.fmt.clock(3725)', c)).toBe('1:02:05')
    expect(vm.runInContext('TK.fmt.clock(null)', c)).toBe('—')
    expect(vm.runInContext('TK.fmt.date(0)', c)).toBe('')
    expect(vm.runInContext('TK.fmt.time(null)', c)).toBe('—')
    expect(vm.runInContext('TK.fmt.rel(new Date(Date.now() - 120000).toISOString())', c)).toBe('2m ago')
    expect(vm.runInContext('TK.fmt.ago(new Date(Date.now() - 5 * 60000).toISOString())', c)).toBe('5 min ago')
    expect(vm.runInContext('TK.fmt.until(Date.now() / 1000 + 90 * 60)', c)).toBe('in 1h 30m')
  })
})
