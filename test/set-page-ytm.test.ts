// The set page's YouTube Music button: the script that builds it parses, and
// the video id regex survives the template literal (a slipped escape would
// leave a bare `/` that ends the regex early).
import { describe, it, expect } from 'vitest'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import type { Env } from '../src/types'
import { app } from '../src/index'

const makeEnv = () => ({ CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', DEV_BYPASS_CF_ACCESS: '1' }) as unknown as Env

describe('/ui/set YouTube Music button', () => {
  it('ships a parsing script whose video id regex reads watch and short links', async () => {
    const page = await (await app.request('http://x/ui/set', {}, makeEnv())).text()
    expect(page).toContain('YouTube Music ↗')
    expect(page).toContain("'btn primary small ytm'")
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
    for (const js of scripts) expect(() => new Function(js)).not.toThrow()
    const src = scripts.find((s) => s.includes('function videoIdOf'))!
    const videoIdOf = new Function(src.slice(src.indexOf('function videoIdOf'), src.indexOf('function renderYtm')) + '; return videoIdOf')()
    expect(videoIdOf('https://www.youtube.com/watch?v=7-HvbsxBq-4&t=3')).toBe('7-HvbsxBq-4')
    expect(videoIdOf('https://youtu.be/9Z8W5-47Ym0')).toBe('9Z8W5-47Ym0')
    expect(videoIdOf('https://www.youtube.com/embed/9Z8W5-47Ym0')).toBe('9Z8W5-47Ym0')
    expect(videoIdOf(null)).toBeNull()
  })
})
