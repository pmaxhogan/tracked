import { describe, it, expect } from 'vitest'
import type { Env } from '../src/types'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import { addSubscription, importSubscriptionsFromKv, listSubscriptions, removeSubscription } from '../src/lib/subscriptions'

function makeEnv(): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k' } as Env
}

describe('subscriptions (D1)', () => {
  it('adds, lists in insertion order, dedupes and removes', async () => {
    const env = makeEnv()
    expect(await listSubscriptions(env)).toEqual([])
    const a = await addSubscription(env, 'https://www.1001tracklists.com/dj/lillypalmer/index.html')
    expect(a.added).toBe(true)
    expect(a.subscription.slug).toBe('lillypalmer')
    const b = await addSubscription(env, 'https://www.1001tracklists.com/dj/matroda/')
    expect(b.added).toBe(true)
    const again = await addSubscription(env, 'lillypalmer')
    expect(again.added).toBe(false)
    expect(again.subscription.sourceUrl).toBe('https://www.1001tracklists.com/dj/lillypalmer/index.html')
    expect((await listSubscriptions(env)).map((s) => s.slug)).toEqual(['lillypalmer', 'matroda'])

    expect(await removeSubscription(env, 'LillyPalmer')).toBe(true)
    expect(await removeSubscription(env, 'lillypalmer')).toBe(false)
    expect((await listSubscriptions(env)).map((s) => s.slug)).toEqual(['matroda'])
    // Re-adding goes to the end.
    await addSubscription(env, 'lillypalmer')
    expect((await listSubscriptions(env)).map((s) => s.slug)).toEqual(['matroda', 'lillypalmer'])
  })

  it('rejects garbage input', async () => {
    const env = makeEnv()
    await expect(addSubscription(env, 'https://example.com/dj/x/')).rejects.toThrow(/could not parse/)
    await expect(removeSubscription(env, 'with/slash')).rejects.toThrow(/invalid slug/)
  })

  it('imports the legacy KV list once, preserving order and metadata', async () => {
    const env = makeEnv()
    await env.SUBS.put('subs:list', JSON.stringify(['zed', 'alpha']))
    await env.SUBS.put('subs:item:zed', JSON.stringify({ sourceUrl: 'https://www.1001tracklists.com/dj/zed/', addedAt: 100 }))
    // alpha has no metadata row: falls back to the canonical URL.
    const list = await listSubscriptions(env)
    expect(list).toEqual([
      { slug: 'zed', sourceUrl: 'https://www.1001tracklists.com/dj/zed/', addedAt: 100 },
      { slug: 'alpha', sourceUrl: 'https://www.1001tracklists.com/dj/alpha/index.html', addedAt: 0 },
    ])
    expect(await env.SUBS.get('migrate:d1:subs')).not.toBeNull()
  })

  it('never refills an emptied table from the stale KV copy', async () => {
    const env = makeEnv()
    await env.SUBS.put('subs:list', JSON.stringify(['zed']))
    await listSubscriptions(env) // imports
    expect(await removeSubscription(env, 'zed')).toBe(true)
    expect(await listSubscriptions(env)).toEqual([])
    expect(await importSubscriptionsFromKv(env)).toBe(false)
  })

  it('marks an empty KV list as migrated so it is not re-read', async () => {
    const env = makeEnv()
    expect(await importSubscriptionsFromKv(env)).toBe(false)
    expect(await env.SUBS.get('migrate:d1:subs')).not.toBeNull()
  })
})
