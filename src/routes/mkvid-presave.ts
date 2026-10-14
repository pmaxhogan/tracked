/**
 * mkvid's third queue: pre-save match searches (lib/presave-match.ts). Gated
 * by MKVID_TOKEN like /mkvid, mounted at /mkvid/presave in src/index.ts ahead
 * of /mkvid. mkvid only polls it once /mkvid/health says `presaveSearch: true`.
 *
 *   POST /mkvid/presave/search/claim    { kinds?: ['ytm'|'slsk'] } -> { job: SearchJob | null, outcome }
 *   POST /mkvid/presave/search/complete { searchId, references: [...], candidates: [...] }
 *                                       -> { status: 'done', decisions, wantClips, nextAt } (404 unknown search)
 *   POST /mkvid/presave/search/fail     { searchId, error, retryAfterSeconds? } -> { status, attempts, nextAt }
 *   POST /mkvid/presave/clip?searchId=&ref=<kind>|&matchId=<id>   body: audio (<= 1.5 MB)
 *                                       -> { key } (404 unknown target, 413 too big, 503 no clip storage)
 *
 * Bad fields are cut or dropped, never a 400, where a 400 would leave mkvid
 * resending the same report forever; a body that is not the shape at all is a 400.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { mkvidAuth } from "../middleware/auth";
import { makeLogger, errorFields } from "../lib/log";
import {
  claimSearchJob,
  completeSearchJob,
  failSearchJob,
  storeClip,
  type CompleteBody,
} from "../lib/presave-match";

export const CLIP_MAX_BYTES = 1_500_000;

const ClaimBody = z.object({
  kinds: z
    .array(z.enum(["ytm", "slsk"]))
    .max(2)
    .optional(),
});

const Score = z.object({
  ref: z.string().max(40),
  score: z.number().nullable().optional(),
  ber: z.number().nullable().optional(),
  offsetSeconds: z.number().nullable().optional(),
  overlapSeconds: z.number().nullable().optional(),
});
const Candidate = z.object({
  source: z.enum(["ytm", "slsk", "spotify"]),
  externalId: z.string().min(1).max(1500),
  url: z.string().max(1500).nullable().optional(),
  title: z.string().max(1000).nullable().optional(),
  artist: z.string().max(1000).nullable().optional(),
  album: z.string().max(1000).nullable().optional(),
  channelTitle: z.string().max(1000).nullable().optional(),
  videoType: z.string().max(100).nullable().optional(),
  durationSeconds: z.number().nullable().optional(),
  scores: z.array(Score).max(10).optional(),
  extra: z.record(z.unknown()).nullable().optional(),
});
const Reference = z.object({
  kind: z.string().min(1).max(40),
  url: z.string().max(1500).nullable().optional(),
  previewUrl: z.string().max(1500).nullable().optional(),
  ok: z.boolean(),
  durationSeconds: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
});
const CompleteSchema = z.object({
  searchId: z.string().min(1).max(40),
  references: z.array(Reference).max(10).default([]),
  candidates: z.array(Candidate).max(30).default([]),
});
const FailSchema = z.object({
  searchId: z.string().min(1).max(40),
  error: z
    .string()
    .min(1)
    .transform((s) => s.slice(0, 1000)),
  retryAfterSeconds: z.number().nullable().optional(),
});

export const mkvidPresaveApp = new Hono<{ Bindings: Env }>();
mkvidPresaveApp.use("*", mkvidAuth);

function logger(c: { req: { raw: Request } }, route: string) {
  return makeLogger({ reqId: c.req.raw.headers.get("cf-ray") ?? "local", route });
}

mkvidPresaveApp.post("/search/claim", async (c) => {
  const log = logger(c, "mkvid.presave.claim");
  const parsed = ClaimBody.safeParse((await c.req.json().catch(() => null)) ?? {});
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  try {
    return c.json(await claimSearchJob(c.env, parsed.data.kinds ?? ["ytm"], log));
  } catch (e) {
    log.error("presave_match.claim_threw", errorFields(e));
    return c.json({ error: "claim_failed", ...errorFields(e) }, 500);
  }
});

mkvidPresaveApp.post("/search/complete", async (c) => {
  const log = logger(c, "mkvid.presave.complete");
  const parsed = CompleteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  try {
    const r = await completeSearchJob(c.env, parsed.data as CompleteBody, log);
    if (r.status === "not_found") return c.json({ error: "not_found" }, 404);
    return c.json(r);
  } catch (e) {
    log.error("presave_match.complete_threw", {
      searchId: parsed.data.searchId,
      ...errorFields(e),
    });
    return c.json({ error: "complete_failed", ...errorFields(e) }, 500);
  }
});

mkvidPresaveApp.post("/search/fail", async (c) => {
  const log = logger(c, "mkvid.presave.fail");
  const parsed = FailSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const r = await failSearchJob(c.env, parsed.data, log);
  if (r.status === "not_found") return c.json({ error: "not_found" }, 404);
  return c.json(r);
});

mkvidPresaveApp.post("/clip", async (c) => {
  const searchId = c.req.query("searchId") ?? "";
  const ref = c.req.query("ref") ?? null;
  const matchId = Number(c.req.query("matchId") ?? "") || null;
  const len = Number(c.req.header("content-length") ?? "0");
  if (len > CLIP_MAX_BYTES) return c.json({ error: "too_large" }, 413);
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) return c.json({ error: "invalid_request" }, 400);
  if (body.byteLength > CLIP_MAX_BYTES) return c.json({ error: "too_large" }, 413);
  const type = c.req.header("content-type") ?? "";
  const contentType = /^audio\/[a-z0-9.+-]{1,40}$/i.test(type) ? type : "audio/mpeg";
  const r = await storeClip(c.env, { searchId, ref, matchId }, body, contentType);
  if ("key" in r) return c.json(r);
  if (r.error === "no_storage") return c.json(r, 503);
  if (r.error === "bad_target") return c.json(r, 400);
  return c.json(r, 404);
});
