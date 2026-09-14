/**
 * In-memory KVNamespace for tests: ascending key order like the real thing,
 * metadata on list, `limit` + `cursor` honoured (the cursor is the last key
 * of the previous page, like the real API's opaque cursor but readable). TTLs
 * are accepted and ignored.
 */
export function fakeKV(initial: Record<string, string> = {}): KVNamespace & { _store: Map<string, { value: string; metadata?: unknown }> } {
  const store = new Map<string, { value: string; metadata?: unknown }>(Object.entries(initial).map(([k, value]) => [k, { value }]))
  const kv = {
    _store: store,
    async get(key: string, type?: 'json' | 'text' | { type?: string }) {
      const v = store.get(key)
      if (v === undefined) return null
      const t = typeof type === 'string' ? type : type?.type
      return t === 'json' ? JSON.parse(v.value) : v.value
    },
    async put(key: string, value: string, opts?: { metadata?: unknown; expirationTtl?: number }) {
      store.set(key, { value, metadata: opts?.metadata })
    },
    async delete(key: string) {
      store.delete(key)
    },
    async list({ prefix = '', limit = 1000, cursor }: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const all = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix) && (!cursor || k > cursor))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, v]) => ({ name, metadata: v.metadata }))
      const keys = all.slice(0, limit)
      const complete = all.length <= limit
      return complete
        ? { keys, list_complete: true as const, cacheStatus: null }
        : { keys, list_complete: false as const, cursor: keys[keys.length - 1]!.name, cacheStatus: null }
    },
  }
  return kv as unknown as KVNamespace & { _store: Map<string, { value: string; metadata?: unknown }> }
}
