/**
 * mkvid's fourth queue: audio cue estimation for held sets (lib/audio-backstop.ts,
 * lib/audio-cues.ts). Gated by MKVID_TOKEN like /mkvid, mounted at /mkvid/audio
 * in src/index.ts ahead of /mkvid. mkvid only polls it once /mkvid/health says
 * `audioCues: true`.
 *
 *   POST /mkvid/audio/claim     { sources?: ['soundcloud'|'hearthis'] } -> { job: AudioJob | null }
 *   POST /mkvid/audio/progress  { requestId, note? } -> { ok } (renews the claim; 404 when not claimed)
 *   POST /mkvid/audio/complete  { requestId, setSeconds?, rows: [{ index, cueSeconds, share, onset, votes, source? }],
 *                                 stats?: { withAudio, missing, sources } }
 *                               -> { status: 'done', rows, gated, filled, timedEnough, nextAt } (404 unknown request)
 *   POST /mkvid/audio/fail      { requestId, error, retryAfterSeconds?, permanent? }
 *                               -> { status: 'retry', attempts, nextAt } | { status: 'removed' }
 *                               ('removed': the recording is gone; the request is parked as
 *                               recording_removed, lib/audio-backstop.ts failAudioJob)
 *   GET  /mkvid/audio/status    -> { eligible, due, running, withEstimates, ranAndReleased }
 *
 * mkvid reports every row it had audio for; tracked applies the gate
 * (AUDIO_GATE) and stores only the rows that pass.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { mkvidAuth } from "../middleware/auth";
import { makeLogger, errorFields } from "../lib/log";
import {
  AUDIO_SOURCES,
  audioCueCounts,
  claimAudioJob,
  completeAudioJob,
  failAudioJob,
  progressAudioJob,
} from "../lib/audio-backstop";

const ClaimBody = z.object({
  sources: z.array(z.string().max(40)).max(10).optional(),
});
const ProgressBody = z.object({
  requestId: z.string().min(1).max(100),
  note: z.string().max(500).nullable().optional(),
});
const Row = z.object({
  index: z.number().int().min(0).max(1000),
  cueSeconds: z.number().finite(),
  share: z.number().finite(),
  onset: z.number().finite(),
  votes: z.number().finite(),
  source: z.string().max(40).nullable().optional(),
});
const CompleteBody = z.object({
  requestId: z.string().min(1).max(100),
  setSeconds: z.number().finite().nullable().optional(),
  rows: z.array(Row).max(1000),
  stats: z
    .object({
      withAudio: z.number().finite().optional(),
      missing: z.number().finite().optional(),
      sources: z.record(z.number().finite()).optional(),
    })
    .optional(),
});
const FailBody = z.object({
  requestId: z.string().min(1).max(100),
  error: z
    .string()
    .min(1)
    .transform((s) => s.slice(0, 1000)),
  retryAfterSeconds: z.number().finite().nullable().optional(),
  permanent: z.boolean().optional(),
});

export const mkvidAudioApp = new Hono<{ Bindings: Env }>();
mkvidAudioApp.use("*", mkvidAuth);

function logger(c: { req: { raw: Request } }, route: string) {
  return makeLogger({ reqId: c.req.raw.headers.get("cf-ray") ?? "local", route });
}

mkvidAudioApp.post("/claim", async (c) => {
  const log = logger(c, "mkvid.audio.claim");
  const parsed = ClaimBody.safeParse((await c.req.json().catch(() => null)) ?? {});
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  try {
    return c.json({
      job: await claimAudioJob(c.env, parsed.data.sources ?? AUDIO_SOURCES, { log }),
    });
  } catch (e) {
    log.error("audio_cues.claim_threw", errorFields(e));
    return c.json({ error: "claim_failed", ...errorFields(e) }, 500);
  }
});

mkvidAudioApp.post("/progress", async (c) => {
  const parsed = ProgressBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const ok = await progressAudioJob(c.env, parsed.data);
  return ok ? c.json({ ok }) : c.json({ error: "not_claimed" }, 404);
});

mkvidAudioApp.post("/complete", async (c) => {
  const log = logger(c, "mkvid.audio.complete");
  const parsed = CompleteBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  try {
    const r = await completeAudioJob(c.env, parsed.data, { log });
    if (r.status === "not_found") return c.json({ error: "not_found" }, 404);
    return c.json(r);
  } catch (e) {
    log.error("audio_cues.complete_threw", { requestId: parsed.data.requestId, ...errorFields(e) });
    return c.json({ error: "complete_failed", ...errorFields(e) }, 500);
  }
});

mkvidAudioApp.post("/fail", async (c) => {
  const log = logger(c, "mkvid.audio.fail");
  const parsed = FailBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const r = await failAudioJob(c.env, parsed.data, { log });
  if (r.status === "not_found") return c.json({ error: "not_found" }, 404);
  return c.json(r);
});

mkvidAudioApp.get("/status", async (c) => c.json(await audioCueCounts(c.env)));
