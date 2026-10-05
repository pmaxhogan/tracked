/**
 * The sets mkvid is working on right now, for the mkvid page's progress
 * bars: GET <MKVID_URL>/api/videos/render-progress (mkvid's TRACKED_TOKEN as
 * the bearer, plus the Access service token when set — the same path the
 * delete call uses). mkvid runs up to two jobs at once, never in the same
 * stage, and splits each into weighted stages (download, analyse, render,
 * assemble, upload); a job queued for the stage the other one holds is
 * `waiting` for it. This whitelists what comes back and adds each set's URL
 * from D1. Read-only; nothing is stored. An mkvid from before two jobs sends
 * only `running`.
 */

import type { Env } from '../types'
import { getMkvidRequest } from './mkvid'
import { mkvidCall } from './mkvid-recreate'

export type RenderStage = { key: string; label: string; weight: number; state: 'done' | 'active' | 'pending'; progress: number | null }
export type RenderProgressView = {
  requestId: string | null
  setUrl: string | null
  slug: string | null
  title: string | null
  stage: string
  /** The stage this job is queued for while the other job runs it; null when it is running. */
  waiting: string | null
  /** 0..1 over the whole job, by the stage weights. */
  fraction: number
  renderMinutesLeft: number | null
  segments: { done: number; total: number } | null
  /** Unix seconds. */
  startedAt: number | null
  stages: RenderStage[]
}
/** `running` = the first of `jobs` (oldest), for callers that show one. */
export type RenderProgressResult = { ok: true; running: RenderProgressView | null; jobs: RenderProgressView[] } | { ok: false; error: string }

/** mkvid runs two; anything past this is not a list of jobs in flight. */
const MAX_JOBS = 4

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY = /^[a-z]{1,16}$/
const STATES = new Set(['done', 'active', 'pending'])

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const unit = (v: unknown): number | null => {
  const n = fin(v)
  return n === null ? null : Math.max(0, Math.min(1, n))
}
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/** Whitelist mkvid's answer; null when it is not a usable progress object. */
export function normalizeRenderProgress(raw: unknown): Omit<RenderProgressView, 'setUrl' | 'slug'> | null {
  if (!isObj(raw)) return null
  const stages: RenderStage[] = []
  for (const s of Array.isArray(raw.stages) ? raw.stages.slice(0, 8) : []) {
    if (!isObj(s) || typeof s.key !== 'string' || !KEY.test(s.key)) return null
    const weight = fin(s.weight)
    if (weight === null || weight <= 0 || !STATES.has(String(s.state))) return null
    stages.push({ key: s.key, label: str(s.label, 24) ?? s.key, weight, state: s.state as RenderStage['state'], progress: unit(s.progress) })
  }
  const stage = typeof raw.stage === 'string' && KEY.test(raw.stage) ? raw.stage : null
  if (!stages.length || !stage || !stages.some((s) => s.key === stage)) return null
  const seg = isObj(raw.segments) ? raw.segments : null
  const done = fin(seg?.done), total = fin(seg?.total)
  const started = fin(raw.startedAt)
  const left = fin(raw.renderMinutesLeft)
  return {
    requestId: typeof raw.requestId === 'string' && UUID.test(raw.requestId) ? raw.requestId : null,
    title: str(raw.title, 300),
    stage,
    waiting: typeof raw.waiting === 'string' && stages.some((s) => s.key === raw.waiting) ? raw.waiting : null,
    fraction: unit(raw.fraction) ?? 0,
    renderMinutesLeft: left !== null && left >= 0 ? Math.round(left) : null,
    segments: done !== null && total !== null && total > 0 && done >= 0 ? { done: Math.min(done, total), total } : null,
    // mkvid stores milliseconds.
    startedAt: started !== null && started > 0 ? Math.floor(started > 1e11 ? started / 1000 : started) : null,
    stages,
  }
}

export async function fetchMkvidRenderProgress(env: Env, fetcher: typeof fetch = fetch): Promise<RenderProgressResult> {
  const call = mkvidCall(env)
  if (!call) return { ok: false, error: 'MKVID_URL / MKVID_TOKEN not set' }
  let res: Response
  try {
    res = await fetcher(`${call.base}/api/videos/render-progress`, { headers: call.headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  } catch (e) {
    return { ok: false, error: `mkvid unreachable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) }
  }
  if (!res.ok) return { ok: false, error: `mkvid answered ${res.status}` }
  const body = (await res.json().catch(() => null)) as unknown
  if (!isObj(body) || !('running' in body)) return { ok: false, error: 'mkvid sent an unexpected answer' }
  const raw = Array.isArray(body.jobs) ? body.jobs.slice(0, MAX_JOBS) : body.running === null ? [] : [body.running]
  const parsed = raw.map(normalizeRenderProgress)
  if (parsed.some((p) => !p)) return { ok: false, error: 'mkvid sent an unexpected answer' }
  const jobs = await Promise.all(parsed.map(async (p) => {
    const req = p!.requestId ? await getMkvidRequest(env, p!.requestId).catch(() => null) : null
    return { ...p!, title: req?.setTitle ?? p!.title, setUrl: req?.setUrl ?? null, slug: req?.slug ?? null }
  }))
  return { ok: true, running: jobs[0] ?? null, jobs }
}
