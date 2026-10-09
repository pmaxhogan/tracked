/**
 * The Pre-saves and Track uploads cards on /ui/settings: the new field kinds
 * (select, text, list) fill from and read back to the settings document, and
 * what they read validates against the app settings schema.
 */
import { describe, it, expect } from 'vitest'
import { SETTINGS_FORM_JS } from '../src/ui/pages/settings-form'
import { SETTINGS_PAGE } from '../src/ui/pages/settings'
import { DEFAULT_APP_SETTINGS, updateAppSettings } from '../src/lib/app-settings'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'

type El = { value: string; placeholder: string; options: Array<{ textContent: string }> }
type Field = { path: string; kind?: string; options?: Array<{ value: string; label: string }>; max?: number; maxLength?: number; nullable?: boolean }
type Group = { id: string; title: string; fields: Field[] }

/** SF over a fake document: getElementById hands out one plain object per id. */
function loadSF() {
  const els = new Map<string, El>()
  const document = { getElementById: (id: string) => (els.has(id) ? els.get(id) : (els.set(id, { value: '', placeholder: '', options: [{ textContent: '' }] }), els.get(id))) }
  const SF = new Function('document', `${SETTINGS_FORM_JS}; return SF;`)(document) as {
    fill: (groups: Group[], values: unknown, placeholders?: unknown) => void
    read: (g: Group) => { patch: Record<string, unknown>; errors: Record<string, string> }
  }
  const el = (g: Group, path: string) => document.getElementById('sf-' + g.id + '-' + path.replace(/[^A-Za-z0-9]/g, '-'))!
  return { SF, el }
}

const groups = (): Group[] => {
  const html = SETTINGS_PAGE.html
  const m = html.match(/const APP_GROUPS = (\[[\s\S]*?\]);\n/)
  return JSON.parse(m![1]!) as Group[]
}

describe('settings form: pre-save and track upload cards', () => {
  it('the page carries both groups with select, text and list fields', () => {
    const gs = groups()
    const presave = gs.find((g) => g.id === 'sf-presave')!
    const tu = gs.find((g) => g.id === 'sf-track-uploads')!
    expect(presave.fields.map((f) => f.path)).toEqual(Object.keys(DEFAULT_APP_SETTINGS.presave).map((k) => `presave.${k}`))
    expect(tu.fields.map((f) => f.path)).toEqual(Object.keys(DEFAULT_APP_SETTINGS.trackUploads).map((k) => `trackUploads.${k}`))
    expect(presave.fields.find((f) => f.path === 'presave.priority')).toMatchObject({ kind: 'select' })
    expect(tu.fields.find((f) => f.path === 'trackUploads.allowedSources')).toMatchObject({ kind: 'list' })
    expect(tu.fields.find((f) => f.path === 'trackUploads.playlistTitle')).toMatchObject({ kind: 'text' })
    // No em dash inside a help text (they are tooltips' tone).
    for (const g of [presave, tu]) for (const f of g.fields as Array<Field & { help: string }>) expect(f.help).not.toMatch(/—/)
  })

  it('fill then read gives back the same document, which validates', async () => {
    const { SF, el } = loadSF()
    const gs = groups().filter((g) => g.id === 'sf-presave' || g.id === 'sf-track-uploads')
    SF.fill(gs, DEFAULT_APP_SETTINGS, DEFAULT_APP_SETTINGS)
    const [presave, tu] = gs as [Group, Group]
    expect(el(tu, 'trackUploads.allowedSources').value).toBe('soundcloud, bandcamp, hearthis, mixcloud')
    expect(el(presave, 'presave.priority').value).toBe('recheck')
    const patch = { ...SF.read(presave).patch, ...SF.read(tu).patch }
    expect(patch).toEqual({ presave: DEFAULT_APP_SETTINGS.presave, trackUploads: DEFAULT_APP_SETTINGS.trackUploads })

    el(tu, 'trackUploads.allowedSources').value = ' soundcloud , ,hearthis '
    el(tu, 'trackUploads.playlistTitle').value = '  My rips '
    el(tu, 'trackUploads.privacy').value = 'private'
    el(presave, 'presave.priority').value = 'backfill'
    const edited = { ...SF.read(presave).patch, ...SF.read(tu).patch } as { presave: { priority: string }; trackUploads: { allowedSources: string[]; playlistTitle: string; privacy: string } }
    expect(edited.trackUploads).toMatchObject({ allowedSources: ['soundcloud', 'hearthis'], playlistTitle: 'My rips', privacy: 'private' })
    expect(edited.presave.priority).toBe('backfill')
    const saved = await updateAppSettings({ SUBS: fakeKV() } as unknown as Env, edited)
    expect(saved.ok && saved.settings.trackUploads.allowedSources).toEqual(['soundcloud', 'hearthis'])
  })

  it('reads reject a value outside the choices, a blank required text and too many list items', () => {
    const { SF, el } = loadSF()
    const tu = groups().find((g) => g.id === 'sf-track-uploads')!
    SF.fill([tu], DEFAULT_APP_SETTINGS)
    el(tu, 'trackUploads.privacy').value = 'secret'
    el(tu, 'trackUploads.playlistTitle').value = '   '
    el(tu, 'trackUploads.allowedSources').value = Array.from({ length: 21 }, (_, i) => `s${i}`).join(',')
    const { errors } = SF.read(tu)
    expect(Object.keys(errors).sort()).toEqual(['trackUploads.allowedSources', 'trackUploads.playlistTitle', 'trackUploads.privacy'])
  })
})
