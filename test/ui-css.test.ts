import { describe, it, expect } from 'vitest'
import { TOKENS_CSS } from '../src/ui/tokens'
import { BASE_CSS } from '../src/ui/base'

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
})
