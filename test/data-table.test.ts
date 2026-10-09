import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { RUNTIME_JS } from '../src/ui/runtime'
import { DATA_TABLE_JS, DATA_TABLE_CSS } from '../src/ui/data-table'
import { runLocalTable, parseTableQuery, type TableDef } from '../src/lib/table-query'

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }

/** A stub DOM: elements by id persist, the root records its listeners, timers are recorded. */
function setup(opts: { search?: string; answer?: (url: string) => unknown; body?: boolean } = {}) {
  const els = new Map<string, any>()
  const el = (): any => ({ innerHTML: '', textContent: '', value: '', hidden: false, className: '', dataset: {}, style: {},
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] })
  const root: any = { ...el(), handlers: {} as Record<string, (e: unknown) => void>, addEventListener(t: string, f: (e: unknown) => void) { this.handlers[t] = f } }
  const fetches: string[] = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  const replaced: string[] = []
  const location = { search: opts.search ?? '', pathname: '/ui/x', hash: '' }
  els.set('host', root)
  const pops: any[] = []
  const body = opts.body ? { appendChild(p: any) { pops.push(p) } } : undefined
  const document: any = {
    hidden: false, body,
    getElementById: (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id))),
    querySelector: () => null, addEventListener() {}, removeEventListener() {},
    createElement: () => {
      const p: any = { ...el(), handlers: {} as Record<string, (e: unknown) => void>, inputs: {} as Record<string, unknown>, contains: () => false,
        addEventListener(t: string, f: (e: unknown) => void) { this.handlers[t] = f },
        querySelector(sel: string) { return this.inputs[sel] ?? null } }
      return p
    },
  }
  const ctx = vm.createContext({
    document, console, Date, URLSearchParams, AbortController, location,
    history: { state: null, replaceState(_s: unknown, _t: string, u: string) { replaced.push(u); const i = u.indexOf('?'); location.search = i < 0 ? '' : u.slice(i).replace(/#.*$/, '') } },
    setTimeout: (fn: () => void, ms: number) => (timers.push({ fn, ms }), timers.length), clearTimeout() {},
    fetch: async (u: string) => { fetches.push(u); return Response.json(opts.answer ? opts.answer(u) : { rows: [], total: 0, page: 1, size: 50, pageCount: 1 }) },
  })
  vm.runInContext(RUNTIME_JS, ctx)
  vm.runInContext(DATA_TABLE_JS, ctx)
  return { ctx, els, root, fetches, timers, replaced, location, pops, run: (code: string) => vm.runInContext(code, ctx) }
}

/** A click target: data-* attributes, and closest() answering the selectors the table asks for. */
function target(attrs: Record<string, string>, extra: { tr?: any; button?: boolean } = {}): any {
  const t: any = {
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    closest(sel: string) {
      if (sel === '[data-tkt]') return 'data-tkt' in attrs ? t : null
      if (sel === '[data-tkp]') return 'data-tkp' in attrs ? t : null
      if (sel === '[data-act]') return 'data-act' in attrs ? t : null
      if (sel === 'tr[data-tkt-row]') return extra.tr ?? null
      if (sel.startsWith('a, button')) return extra.button ? t : null
      return null
    },
  }
  return t
}
const rowTarget = (i: number) => target({}, { tr: target({ 'data-tkt-row': String(i) }) })
const decode = (u: string) => decodeURIComponent(u)

const COLS = `[
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'n', label: 'Count', type: 'number' },
  { key: 'stage', label: 'Stage', type: 'enum', options: [{ value: 'found', label: 'Found' }, 'links'] },
  { key: 'at', label: 'Saved', type: 'datetime' },
]`

describe('DATA_TABLE_JS at load', () => {
  it('is define-only: one global, no timers, fetches or DOM access, in the minimal pool stub', () => {
    let timers = 0, fetches = 0, dom = 0
    const document = new Proxy({}, { get: () => { dom++; return () => null } })
    const c = vm.createContext({ document, console, setTimeout: () => (timers++, 0), setInterval: () => (timers++, 0), fetch: async () => (fetches++, new Response('{}')) })
    vm.runInContext(DATA_TABLE_JS, c)
    expect(vm.runInContext('typeof TKTable.create', c)).toBe('function')
    expect([timers, fetches, dom]).toEqual([0, 0, 0])
    expect(() => new vm.Script(DATA_TABLE_JS)).not.toThrow()
  })
  it('keeps to the page-test rules: no title attributes, no em dash, no gradients, no backticks', () => {
    expect(DATA_TABLE_JS).not.toMatch(/\stitle="/)
    expect(DATA_TABLE_JS).not.toMatch(/\.title = /)
    expect(DATA_TABLE_JS).not.toContain('—')
    expect(DATA_TABLE_JS).not.toContain('`')
    expect(DATA_TABLE_JS).not.toMatch(/quiet/i)
    expect(DATA_TABLE_CSS).not.toMatch(/gradient\(/)
    expect(DATA_TABLE_CSS).toContain('max-width: 699px')
  })
})

describe('server mode', () => {
  it('builds the request from URL state and params, keeping the page\'s own params', async () => {
    const t = setup({ search: '?keep=1&t1.page=2&t1.f.stage=in:found&other.page=9' })
    t.run(`window_t = TKTable.create(document.getElementById('host'), { id: 't1', source: { url: '/api/x', params: () => ({ dj: 'a', none: null }) }, columns: ${COLS}, defaultSort: '-at' })`)
    await settle()
    expect(t.fetches).toHaveLength(1)
    expect(decode(t.fetches[0]!)).toBe('/api/x?page=2&size=50&sort=-at&f.stage=in:found&dj=a')
    expect(t.run('window_t.state().filters')).toEqual([{ col: 'stage', op: 'in', value: 'found' }])
  })

  it('paints rows, the header, the pager and the status; the server page wins', async () => {
    const rows = [{ id: 1, name: 'Alpha <b>', n: 1234, stage: 'found', at: 1_700_000_000_000 }, { id: 2, name: 'Beta', n: null, stage: 'links', at: null }]
    const t = setup({ answer: () => ({ rows, total: 1234, page: 3, size: 50, pageCount: 25, counts: { found: 7 } }) })
    t.run(`window_t = TKTable.create(document.getElementById('host'), { id: 't1', source: { url: '/api/x' }, columns: ${COLS}, defaultSort: '-at', pageSize: 50,
      chips: [{ id: 'found', label: 'Found', filters: [{ col: 'stage', op: 'in', value: 'found' }], count: (r) => r.counts.found }],
      actions: () => '<button type="button" data-act="go">Go</button>', onData: (d) => { window_data = d } })`)
    await settle()
    const body = t.els.get('t1-body').innerHTML as string
    expect(body).toContain('Alpha &lt;b&gt;')
    expect(body).toContain('data-label="Count"')
    expect(body).toContain('1,234')
    expect(body).toContain('data-act="go"')
    const head = t.els.get('t1-head').innerHTML as string
    expect(head).toContain('aria-sort="descending"') // the default sort on Saved
    expect(head).toContain('data-tkt="filter" data-col="stage"')
    expect(head).toMatch(/<th class="tkt-acts">/)
    const pager = t.els.get('t1-pager').innerHTML as string
    expect(pager).toContain('101–150 of 1,234')
    expect(pager).toContain('aria-current="page"')
    expect(pager).toContain('data-page="25"')
    expect(pager).toContain('…')
    expect(pager).toContain('data-tkt="jump"')
    expect(pager).toContain('<option value="50" selected>')
    expect(t.els.get('t1-status').innerHTML).toBe('101–150 of 1,234 rows')
    expect(t.els.get('t1-chips').innerHTML).toContain('<span class="tkt-count">7</span>')
    expect(t.run('window_t.state().page')).toBe(3)
    expect(t.run('window_data.counts.found')).toBe(7)
    expect(t.els.get('t1-wrap').hidden).toBe(false)
    expect(t.els.get('t1-empty').hidden).toBe(true)
    // a page button fetches that page
    const click = (tg: unknown, ev: Record<string, unknown> = {}) => (t.ctx as any).window_t._click({ target: tg, ...ev })
    click(target({ 'data-tkt': 'page', 'data-page': '25' }))
    await settle()
    expect(decode(t.fetches.at(-1)!)).toContain('page=25&')
  })

  it('header click cycles asc, desc, none; shift-click adds a secondary sort; URL state follows', async () => {
    const t = setup({ search: '?keep=1' })
    t.run(`window_t = TKTable.create(document.getElementById('host'), { id: 't1', source: { url: '/api/x' }, columns: ${COLS}, defaultSort: '-at' })`)
    await settle()
    const click = (tg: unknown, ev: Record<string, unknown> = {}) => (t.ctx as any).window_t._click({ target: tg, ...ev })
    const sortOf = () => new URLSearchParams(t.fetches.at(-1)!.split('?')[1]).get('sort')
    click(target({ 'data-tkt': 'sort', 'data-col': 'name' })); await settle()
    expect(sortOf()).toBe('name')
    expect(t.location.search).toBe('?keep=1&t1.sort=name')
    click(target({ 'data-tkt': 'sort', 'data-col': 'name' })); await settle()
    expect(sortOf()).toBe('-name')
    click(target({ 'data-tkt': 'sort', 'data-col': 'name' })); await settle()
    expect(sortOf()).toBe('-at')
    expect(t.location.search).toBe('?keep=1')
    click(target({ 'data-tkt': 'sort', 'data-col': 'name' })); await settle()
    click(target({ 'data-tkt': 'sort', 'data-col': 'n' }), { shiftKey: true }); await settle()
    expect(sortOf()).toBe('name,n')
    const head = t.els.get('t1-head').innerHTML as string
    expect(head).toContain('<span class="tkt-prio" aria-label="sort priority 2">2</span>')
    click(target({ 'data-tkt': 'sort', 'data-col': 'name' }), { shiftKey: true }); await settle()
    expect(sortOf()).toBe('-name,n')
    // a plain click on a descending column clears the user sort; a shift-click then keeps the default and adds the column
    click(target({ 'data-tkt': 'sort', 'data-col': 'name' })); await settle()
    expect(sortOf()).toBe('-at')
    click(target({ 'data-tkt': 'sort', 'data-col': 'n' }), { shiftKey: true }); await settle()
    expect(sortOf()).toBe('-at,n')
  })

  it('preset chips are exclusive per group; filters become f.<col> params and removable chips', async () => {
    const t = setup()
    t.run(`window_t = TKTable.create(document.getElementById('host'), { id: 't1', source: { url: '/api/x' }, columns: ${COLS},
      chips: [{ id: 'all', label: 'All', group: 's', on: true }, { id: 'found', label: 'Found', group: 's', filters: [{ col: 'stage', op: 'in', value: 'found' }] },
              { id: 'links', label: 'Links', group: 's', filters: [{ col: 'stage', op: 'in', value: 'links' }], sort: 'name' }] })`)
    await settle()
    const click = (tg: unknown) => (t.ctx as any).window_t._click({ target: tg })
    const params = () => new URLSearchParams(t.fetches.at(-1)!.split('?')[1])
    expect(params().getAll('f.stage')).toEqual([])
    click(target({ 'data-tkt': 'chip', 'data-chip': 'found' })); await settle()
    expect(params().getAll('f.stage')).toEqual(['in:found'])
    expect(t.location.search).toBe('?t1.chip=found')
    click(target({ 'data-tkt': 'chip', 'data-chip': 'links' })); await settle()
    expect(params().getAll('f.stage')).toEqual(['in:links'])
    expect(params().get('sort')).toBe('name') // the chip's sort
    expect(t.els.get('t1-chips').innerHTML).toMatch(/class="chip on" data-tkt="chip" data-chip="links" aria-pressed="true"/)
    t.run(`window_t.setFilter('n', 'gte', '5')`); await settle()
    t.run(`window_t.setFilter('name', 'has', 'mix')`); await settle()
    expect(params().getAll('f.n')).toEqual(['gte:5'])
    expect(params().getAll('f.name')).toEqual(['has:mix'])
    expect(params().get('page')).toBe('1')
    const active = t.els.get('t1-active').innerHTML as string
    expect(active).toContain('Count ≥ 5')
    expect(active).toContain('Name contains &quot;mix&quot;')
    expect(active).toContain('data-tkt="clear"')
    click(target({ 'data-tkt': 'unfilter', 'data-i': '0' })); await settle()
    expect(params().getAll('f.n')).toEqual([])
    expect(params().getAll('f.name')).toEqual(['has:mix'])
    click(target({ 'data-tkt': 'clear' })); await settle()
    expect(params().getAll('f.name')).toEqual([])
    expect(params().getAll('f.stage')).toEqual([])
    expect(t.location.search).toBe('')
  })

  it('the filter popover turns a number range and a day into the contract ops', async () => {
    const t = setup({ body: true })
    t.run(`window_t = TKTable.create(document.getElementById('host'), { id: 't1', source: { url: '/api/x' }, columns: ${COLS} })`)
    await settle()
    const click = (tg: unknown) => (t.ctx as any).window_t._click({ target: tg })
    click(target({ 'data-tkt': 'filter', 'data-col': 'n' }))
    const pop = t.pops[0]
    expect(pop.hidden).toBe(false)
    expect(pop.innerHTML).toContain('name="a" type="number"')
    expect(pop.innerHTML).toContain('data-tkp="apply"')
    pop.inputs['[name="op"]'] = { value: 'between' }
    pop.inputs['input[name="a"]:not([type=radio])'] = { value: '5' }
    pop.inputs['input[name="b"]'] = { value: '' }
    pop.handlers.click({ target: target({ 'data-tkp': 'apply' }) })
    await settle()
    expect(decode(t.fetches.at(-1)!)).toContain('f.n=between:5..')
    expect(pop.hidden).toBe(true)
    click(target({ 'data-tkt': 'filter', 'data-col': 'at' }))
    expect(pop.innerHTML).toContain('type="date"')
    expect(pop.innerHTML).toContain('data-q="7d"')
    pop.inputs = { '[name="op"]': { value: 'on' }, 'input[name="a"]:not([type=radio])': { value: '2026-03-04' } }
    pop.handlers.click({ target: target({ 'data-tkp': 'apply' }) })
    await settle()
    const start = new Date(2026, 2, 4).getTime(), end = new Date(2026, 2, 5).getTime() - 1
    expect(decode(t.fetches.at(-1)!)).toContain(`f.at=between:${start}..${end}`)
    expect(t.els.get('t1-active').innerHTML).toContain('Saved on ')
    click(target({ 'data-tkt': 'filter', 'data-col': 'stage' }))
    expect(pop.innerHTML).toContain('type="checkbox" name="v" value="found"')
    expect(pop.innerHTML).toContain('>Found</label>')
  })

  it('the search box is debounced 250 ms', async () => {
    const t = setup()
    t.run(`window_t = TKTable.create(document.getElementById('host'), { id: 't1', source: { url: '/api/x' }, columns: ${COLS}, search: 'Find' })`)
    await settle()
    expect(t.root.innerHTML).toContain('placeholder="Find"')
    const box = { value: ' mix ', getAttribute: (k: string) => (k === 'data-tkt' ? 'q' : null) }
    ;(t.ctx as any).window_t._input({ target: box })
    expect(t.fetches).toHaveLength(1)
    const timer = t.timers.find((x) => x.ms === 250)!
    timer.fn()
    await settle()
    expect(decode(t.fetches.at(-1)!)).toContain('&q=mix')
  })

  it('drops a stale answer: only the newest request paints', async () => {
    const t = setup()
    const waits: Array<() => void> = []
    ;(t.ctx as any).fetch = (u: string) => new Promise((res) => { t.fetches.push(u); waits.push(() => res(Response.json({ rows: [{ id: u.includes('sort=name') ? 'new' : 'old', name: u }], total: 1, page: 1, size: 50, pageCount: 1 }))) })
    t.run(`window_t = TKTable.create(document.getElementById('host'), { id: 't1', source: { url: '/api/x' }, columns: ${COLS} })`)
    await settle()
    t.run(`window_t.setSort('name')`)
    await settle()
    waits[1]!(); await settle()
    waits[0]!(); await settle()
    expect(t.run('window_t.rows().map((r) => r.id)')).toEqual(['new'])
  })

  it('an error keeps the old rows and offers Retry; row clicks and actions are delegated', async () => {
    let fail = false
    const t = setup({ answer: () => (fail ? { error: 'boom', message: 'It broke' } : { rows: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], total: 2, page: 1, size: 50, pageCount: 1 }) })
    t.run(`window_hits = []; window_t = TKTable.create(document.getElementById('host'), { id: 't1', source: { url: '/api/x' }, columns: ${COLS},
      onRowClick: (row) => window_hits.push('row:' + row.id), onAction: (act, row) => window_hits.push(act + ':' + row.id),
      actions: () => '<button type="button" data-act="del">Delete</button>', rowAttrs: (r) => ({ 'data-x': r.name }) })`)
    await settle()
    expect(t.els.get('t1-body').innerHTML).toContain('data-x="A"')
    expect(t.els.get('t1-body').innerHTML).toContain('tabindex="0"')
    const click = (tg: unknown) => (t.ctx as any).window_t._click({ target: tg })
    click(rowTarget(1))
    click(target({ 'data-act': 'del' }, { tr: target({ 'data-tkt-row': '0' }) }))
    click(target({}, { tr: target({ 'data-tkt-row': '0' }), button: true })) // a link or button in the row is not a row click
    expect(t.run('window_hits')).toEqual(['row:2', 'del:1'])
    fail = true
    ;(t.ctx as any).fetch = async () => Response.json({ error: 'bad_table_query', message: 'unknown column: x' }, { status: 400 })
    t.run('window_t.reload()'); await settle()
    expect(t.els.get('t1-err').hidden).toBe(false)
    expect(t.els.get('t1-err').innerHTML).toContain('unknown column: x')
    expect(t.els.get('t1-err').innerHTML).toContain('data-tkt="retry"')
    expect(t.run('window_t.rows().length')).toBe(2)
  })
})

describe('local mode', () => {
  type R = { id: number; name: string | null; n: number | null; stage: string | null; base: number | null }
  const ROWS: R[] = [
    { id: 1, name: 'Alpha', n: 10, stage: 'found', base: null },
    { id: 2, name: 'beta', n: 5, stage: 'links', base: null },
    { id: 3, name: null, n: null, stage: null, base: null },
    { id: 4, name: 'alpha two', n: 10, stage: 'found', base: null },
    { id: 5, name: 'w/ child', n: 99, stage: 'links', base: 2 },
    { id: 6, name: 'Delta', n: -3, stage: 'links', base: null },
    { id: 7, name: 'w/ other', n: 1, stage: 'found', base: 2 },
  ]
  const DEF: TableDef<R> = {
    primaryKey: 'id', defaultSort: 'id',
    columns: { id: { type: 'number' }, name: { type: 'text', searchable: true }, n: { type: 'number' }, stage: { type: 'enum' } },
  }
  const GDEF: TableDef<R> = { ...DEF, group: { key: (r) => r.base ?? r.id, isChild: (r) => r.base != null } }
  const CLIENT_COLS = `[{ key: 'id', type: 'number' }, { key: 'name', type: 'text' }, { key: 'n', type: 'number' }, { key: 'stage', type: 'enum', searchable: false }]`

  it.each([
    ['', false], ['sort=-n', false], ['sort=name', false], ['sort=-name,n', false], ['f.n=between:1..10', false], ['f.name=nhas:alpha', false],
    ['f.stage=nin:found', false], ['q=ALPHA', false], ['f.n=empty', false], ['size=10&page=5', false],
    ['sort=n', true], ['sort=-n', true], ['sort=name', true], ['f.name=sw:w/', true],
  ])('TKTable.runLocal matches runLocalTable: %s (groups %s)', (s, grouped) => {
    const q = parseTableQuery(new URLSearchParams(s), grouped ? GDEF : DEF)
    const server = runLocalTable(ROWS, grouped ? GDEF : DEF, q)
    const t = setup()
    ;(t.ctx as any).ROWS = ROWS
    ;(t.ctx as any).Q = q
    const client = t.run(`TKTable.runLocal(ROWS, ${CLIENT_COLS}, { sort: Q.sort.length ? Q.sort : TKTable.parseSort('id', { id: 1 }), filters: Q.filters, q: Q.q, page: Q.page, size: Q.size, rowKey: 'id'${grouped ? ', group: { key: (r) => r.base == null ? r.id : r.base, isChild: (r) => r.base != null }' : ''} })`)
    expect(client.rows.map((r: R) => r.id)).toEqual(server.rows.map((r) => r.id))
    expect([client.total, client.page, client.pageCount]).toEqual([server.total, server.page, server.pageCount])
  })

  it('sorts, filters, pages and keeps w/ rows under their parent in the table itself', async () => {
    const t = setup()
    ;(t.ctx as any).ROWS = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: 'row ' + (i + 1), n: (i * 7) % 11, stage: i % 2 ? 'links' : 'found', base: i === 29 ? 1 : null }))
    t.run(`window_t = TKTable.create(document.getElementById('host'), { id: 'lt', source: { rows: () => ROWS }, columns: ${COLS}, defaultSort: 'n', pageSize: 10,
      group: { key: (r) => r.base == null ? r.id : r.base, isChild: (r) => r.base != null } })`)
    await settle()
    expect(t.fetches).toHaveLength(0)
    const ids = () => t.run('window_t.rows().map((r) => r.id)') as number[]
    const first = ids()
    expect(first).toHaveLength(10)
    // row 1 has n = 0 (the lowest): its child 30 (n = 1) follows it right away
    expect(first.slice(0, 2)).toEqual([1, 30])
    expect(t.els.get('lt-body').innerHTML).toMatch(/<tr data-tkt-row="1" data-key="30" class="tkt-child">/)
    expect(t.els.get('lt-body').innerHTML).toMatch(/<tr data-tkt-row="0" data-key="1" class="tkt-parent">/)
    expect(t.els.get('lt-pager').innerHTML).toContain('1–10 of 30')
    t.run(`window_t.setFilter('stage', 'in', 'links')`); await settle()
    expect(t.run('window_t.response().total')).toBe(15)
    expect(ids().every((id) => id % 2 === 0)).toBe(true)
    t.run(`window_t.setPage(9)`); await settle()
    expect(t.run('window_t.state().page')).toBe(2) // clamped
    expect(t.els.get('lt-pager').innerHTML).toContain('11–15 of 15')
    t.run(`window_t.setRows([])`); await settle()
    expect(t.els.get('lt-empty').hidden).toBe(false)
    expect(t.els.get('lt-empty').innerHTML).toContain('No rows match these filters.')
  })

  it('compact mode has no toolbar, pager or filter buttons and stays out of the URL', async () => {
    const t = setup({ search: '?keep=1' })
    t.run(`window_t = TKTable.create(document.getElementById('host'), { id: 'c', compact: true, source: { rows: [{ id: 1, name: 'x' }] }, columns: ${COLS} })`)
    await settle()
    expect(t.root.innerHTML).not.toContain('tkt-bar')
    expect(t.root.innerHTML).not.toContain('tkt-pager')
    expect(t.els.get('c-head').innerHTML).not.toContain('data-tkt="filter"')
    t.run(`window_t.setSort('-name')`); await settle()
    expect(t.replaced).toEqual([])
  })
})
