import { describe, it, expect } from 'vitest'
import { TOKENS_CSS } from '../src/ui/tokens'
import { BASE_CSS } from '../src/ui/base'
import { shell } from '../src/ui/shell'

describe('tokens', () => {
  it('is dark first with the spec values, and light twice (media query and manual)', () => {
    for (const v of ['#101219', '#171a23', '#1f2330', '#2a2f3d', '#3a4052', '#e8e9f0', '#a3a7b8', '#737889', '#a597ff', '#7b6cf6', '#3fb950', '#d29922', '#f85149', '#58a6ff']) expect(TOKENS_CSS).toContain(v)
    for (const v of ['#f6f6fa', '#5b4bd6', '#1a7f37', '#9a6700', '#cf222e', '#0969da']) expect(TOKENS_CSS.split(v).length).toBe(3)
    expect(TOKENS_CSS).toContain('color-scheme: dark')
    expect(TOKENS_CSS).toContain(':root:not([data-theme="dark"])')
    expect(TOKENS_CSS).toContain(':root[data-theme="light"]')
  })
})
describe('base', () => {
  it('defines every component class the pages use', () => {
    for (const c of ['.tk-shell', '.tk-side', '.tk-nav', '.tk-top', '.tk-tabs', '.tk-main', '.tk-head', '.tk-card', '.tk-grid', '.tk-tiles', '.tk-tile', '.tk-meter',
      '.btn', '.btn.primary', '.btn.danger', '.btn.ghost', '.btn.icon', '.badge', '.badge.ok', '.badge.warn', '.badge.bad', '.badge.info', '.badge.neutral',
      '.field', '.chips', '.chip', '.tk-table', '.tk-tabbar', '.tk-drawer', '.tk-dialog', '.tk-toasts', '.toast', '.empty', '.err-state', '.skel', '.mono',
      '.trk', '.set-card', '.ban-alert', '.ban-alert.paused', '.ban-alert.simulated', '.error']) expect(BASE_CSS).toContain(c)
  })
  it('has the three breakpoints and no gradient', () => {
    expect(BASE_CSS).toContain('max-width: 1099px')
    expect(BASE_CSS).toContain('max-width: 799px')
    expect(BASE_CSS).toContain('max-width: 699px')
    expect(BASE_CSS).not.toMatch(/gradient\(/)
  })
  it('never uses the word quiet and keeps content above the fixed tab bar', () => {
    expect(TOKENS_CSS + BASE_CSS).not.toMatch(/quiet/i)
    expect(BASE_CSS).toContain('env(safe-area-inset-bottom)')
    expect(BASE_CSS).toContain('.tk-table-wrap')
    expect(BASE_CSS).toContain('.tk-main.narrow')
  })
  it('scopes field inputs away from checkboxes, cards the ban table, collapses the footer', () => {
    expect(BASE_CSS).toContain('.field input:not([type=checkbox]):not([type=radio])')
    expect(BASE_CSS).toContain('.field.check')
    const phone = BASE_CSS.slice(BASE_CSS.indexOf('max-width: 699px'))
    expect(phone).toContain('.ban-eps')
    expect(BASE_CSS).toContain('.ban-eps .mono { overflow-wrap: anywhere; }')
    const rail = BASE_CSS.slice(BASE_CSS.indexOf('max-width: 1099px'), BASE_CSS.indexOf('max-width: 799px'))
    expect(rail).toContain('.tk-side-foot > :not(.badge) { display: none; }')
    expect(BASE_CSS).toContain('pointer-events: none')
  })
})

describe('shell chrome', () => {
  it('styles every shell element that has no component class of its own', () => {
    for (const c of ['.tk-menu .grp', '.tk-drawer-head', '.tk-top-title', '.tk-brand', '.tk-side-foot']) expect(BASE_CSS).toContain(c)
    expect(BASE_CSS).toMatch(/\.tk-top-title \{[^}]*text-overflow: ellipsis/)
    expect(BASE_CSS).toMatch(/\.tk-drawer-head \{[^}]*display: flex/)
  })
  it('groups the phone menu like the sidebar: Settings and Tools are not under Pool', () => {
    const h = shell({ nav: 'home', title: 'Home', body: '' })
    const menu = h.slice(h.indexOf('<dialog id="tk-menu"'), h.indexOf('</dialog>', h.indexOf('<dialog id="tk-menu"')))
    const side = h.slice(h.indexOf('<nav class="tk-nav"'), h.indexOf('</nav>', h.indexOf('<nav class="tk-nav"')))
    const between = (html: string) => html.slice(html.indexOf('href="/ui/pool/settings"'), html.indexOf('href="/ui/settings"'))
    for (const html of [menu, side]) {
      expect(between(html)).toContain('<div class="grp" aria-hidden="true"></div>')
      expect(html.match(/<div class="grp">[^<]*<\/div>/g)).toEqual(['<div class="grp">Library</div>', '<div class="grp">Pipeline</div>', '<div class="grp">Pool</div>'])
    }
  })
})
