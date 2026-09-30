import { describe, it, expect } from 'vitest'
import { icon, ICON_NAMES } from '../src/ui/icons'

describe('icon()', () => {
  it('returns a 24px-viewBox stroke SVG in currentColor for every name', () => {
    for (const n of ICON_NAMES) {
      const s = icon(n)
      expect(s).toMatch(/^<svg [^>]*viewBox="0 0 24 24"/)
      expect(s).toContain('stroke="currentColor"')
      expect(s).toContain('aria-hidden="true"')
    }
  })
  it('labels an icon when asked, and sizes it', () => {
    expect(icon('menu', { label: 'Menu', size: 20 })).toContain('role="img" aria-label="Menu"')
    expect(icon('menu', { size: 20 })).toContain('width="20"')
  })
  it('defaults to 18px and drops aria-hidden when labelled', () => {
    expect(icon('home')).toContain('width="18" height="18"')
    expect(icon('home', { label: 'Home' })).not.toContain('aria-hidden')
  })
  it('escapes the label attribute', () => {
    const s = icon('home', { label: 'a&b<c>"d' })
    expect(s).toContain('aria-label="a&amp;b&lt;c&gt;&quot;d"')
  })
  it('has 31 unique names, each with drawn children', () => {
    expect(ICON_NAMES.length).toBe(31)
    expect(new Set(ICON_NAMES).size).toBe(31)
    for (const n of ICON_NAMES) expect(icon(n)).toMatch(/<(path|circle|rect|line|polyline|polygon)\b/)
  })
})
