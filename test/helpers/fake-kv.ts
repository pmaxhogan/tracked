/**
 * In-memory KVNamespace for tests: ascending key order like the real thing,
 * metadata on list, `limit` honoured (single page). TTLs are accepted and
 * ignored.
 */
export function fakeKV(): KVNamespace & { _store: Map<string, { value: string; metadata?: unknown }> } {
  const store = new Map<string, { value: string; metadata?: unknown }>()
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
    async list({ prefix = '', limit = 1000 }: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const keys = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, v]) => ({ name, metadata: v.metadata }))
        .slice(0, limit)
      return { keys, list_complete: true, cacheStatus: null }
    },
  }
  return kv as unknown as KVNamespace & { _store: Map<string, { value: string; metadata?: unknown }> }
}
