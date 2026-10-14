/** In-memory R2 bucket for tests: put / get / delete / list (prefix, cursor, startAfter, limit, customMetadata). */
type Obj = {
  body: Uint8Array;
  httpMetadata?: { contentEncoding?: string; contentType?: string };
  customMetadata?: Record<string, string>;
  uploaded: Date;
};

export function fakeR2(): R2Bucket & { _store: Map<string, Obj>; failPuts: boolean } {
  const store = new Map<string, Obj>();
  const bucket = {
    _store: store,
    failPuts: false,
    async put(
      key: string,
      value: Uint8Array | string,
      opts?: { httpMetadata?: Obj["httpMetadata"]; customMetadata?: Record<string, string> },
    ) {
      if (bucket.failPuts) throw new Error("r2 down");
      const body =
        typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
      store.set(key, {
        body,
        httpMetadata: opts?.httpMetadata,
        customMetadata: opts?.customMetadata,
        uploaded: new Date(),
      });
    },
    async get(key: string) {
      const o = store.get(key);
      if (!o) return null;
      return {
        key,
        httpMetadata: o.httpMetadata,
        customMetadata: o.customMetadata,
        async arrayBuffer() {
          return o.body.buffer.slice(o.body.byteOffset, o.body.byteOffset + o.body.byteLength);
        },
        get body() {
          return new Response(o.body).body;
        },
      };
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async list({
      prefix = "",
      cursor,
      startAfter,
      limit = 1000,
    }: { prefix?: string; cursor?: string; startAfter?: string; limit?: number } = {}) {
      const all = [...store.entries()]
        .filter(
          ([k]) =>
            k.startsWith(prefix) && (!cursor || k > cursor) && (!startAfter || k > startAfter),
        )
        .sort(([a], [b]) => (a < b ? -1 : 1));
      const page = all.slice(0, limit);
      const truncated = all.length > limit;
      return {
        objects: page.map(([key, o]) => ({
          key,
          size: o.body.length,
          uploaded: o.uploaded,
          customMetadata: o.customMetadata,
        })),
        truncated,
        cursor: truncated ? page[page.length - 1]![0] : undefined,
      };
    },
  };
  return bucket as unknown as R2Bucket & { _store: Map<string, Obj>; failPuts: boolean };
}
