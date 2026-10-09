// Field-table settings forms: one card per group, rendered from a descriptor
// list, validated inline (range per field, the server's zod/tlpool issues
// mapped back to the field), saved as one partial document. Used by
// /ui/settings (app settings) and /ui/pool/settings (scheduler + tlpool knobs).
//
// Field: { path: 'retry.djRetryMinutes', label, help, unit, min, max, step,
//          kind?: 'number' | 'bool' | 'select' | 'text' | 'list',
//          options?: [{ value, label }] (select), maxLength? (text, list items),
//          nullable?: true (blank = env/default) }
// select saves the option's value (a string), text a trimmed string, list a
// comma-separated input as a string array (blanks dropped; max = most items).

export type FormField = {
  path: string
  label: string
  help: string
  unit?: string
  min?: number
  max?: number
  step?: number
  kind?: 'number' | 'bool' | 'select' | 'text' | 'list'
  /** select: the choices. */
  options?: Array<{ value: string; label: string }>
  /** text: longest value; list: longest item. */
  maxLength?: number
  /** Blank saves null: the env var, else the code default. */
  nullable?: boolean
}
export type FormGroup = { id: string; title: string; intro?: string; fields: FormField[] }

export const SETTINGS_FORM_CSS = /* css */ `
  .sf-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--sp-2) var(--sp-4); }
  .sf-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .sf-field label { font-weight: 600; font-size: var(--fs-sm); }
  .sf-field .sf-in { display: flex; align-items: center; gap: 6px; }
  .sf-field input, .sf-field select { width: 9em; max-width: 100%; }
  .sf-field input.sf-wide { width: 100%; }
  .sf-field .hint { color: var(--muted); font-size: var(--fs-sm); }
  .sf-field .sf-err { color: var(--danger); font-size: var(--fs-sm); }
  .sf-field.bad input, .sf-field.bad select { border-color: var(--danger); }
  .sf-foot { display: flex; align-items: center; gap: var(--sp-3); margin-top: var(--sp-3); }
  .sf-foot .spacer { flex: 1; }
  .sf-intro { margin-top: 0; }
`

export const SETTINGS_FORM_JS = /* js */ `
  const SF = (() => {
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const idOf = (g, f) => 'sf-' + g.id + '-' + f.path.replace(/[^A-Za-z0-9]/g, '-');
    const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
    function put(o, path, v) {
      const ks = path.split('.');
      let cur = o;
      for (const k of ks.slice(0, -1)) cur = cur[k] = cur[k] && typeof cur[k] === 'object' ? cur[k] : {};
      cur[ks[ks.length - 1]] = v;
      return o;
    }
    function fieldHtml(g, f) {
      const id = idOf(g, f);
      const input = f.kind === 'bool'
        ? '<select id="' + id + '">' + (f.nullable ? '<option value="">env / default</option>' : '') + '<option value="true">On</option><option value="false">Off</option></select>'
        : f.kind === 'select'
        ? '<select id="' + id + '">' + (f.nullable ? '<option value="">env / default</option>' : '') + (f.options || []).map((o) => '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>').join('') + '</select>'
        : f.kind === 'text' || f.kind === 'list'
        ? '<input id="' + id + '" type="text" class="sf-wide" autocomplete="off" spellcheck="false"' + (f.kind === 'text' && f.maxLength ? ' maxlength="' + f.maxLength + '"' : '') + ' />'
        : '<input id="' + id + '" type="number" inputmode="decimal"' + (f.min != null ? ' min="' + f.min + '"' : '') + (f.max != null ? ' max="' + f.max + '"' : '') + ' step="' + (f.step || 'any') + '" />';
      return '<div class="sf-field" data-path="' + esc(f.path) + '"><label for="' + id + '">' + esc(f.label) + '</label>' +
        '<div class="sf-in">' + input + (f.unit ? '<span class="muted">' + esc(f.unit) + '</span>' : '') + '</div>' +
        '<span class="hint">' + esc(f.help) + '</span><span class="sf-err" role="alert"></span></div>';
    }
    /** One <form class="tk-card"> per group into container; onSave(patch, group) -> Promise<{ ok, issues?, message? }>. */
    function mount(container, groups, onSave) {
      container.innerHTML = groups.map((g) => '<form id="' + g.id + '" class="tk-card" autocomplete="off" novalidate><h2>' + esc(g.title) + '</h2>' +
        (g.intro ? '<p class="muted sub sf-intro">' + esc(g.intro) + '</p>' : '') +
        '<div class="error sf-form-err"></div><div class="sf-grid">' + g.fields.map((f) => fieldHtml(g, f)).join('') + '</div>' +
        '<div class="sf-foot"><span class="muted sf-msg" role="status"></span><span class="spacer"></span><button type="submit" class="btn primary">Save</button></div></form>').join('');
      for (const g of groups) {
        const form = document.getElementById(g.id);
        form.addEventListener('input', (ev) => { const fl = ev.target.closest('.sf-field'); if (fl) { fl.classList.remove('bad'); fl.querySelector('.sf-err').textContent = ''; } });
        form.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const { patch, errors } = read(g);
          show(g, errors, '');
          if (Object.keys(errors).length) return;
          const btn = form.querySelector('button[type=submit]');
          btn.disabled = true; form.querySelector('.sf-msg').textContent = 'saving…';
          const r = await onSave(patch, g).catch(() => ({ ok: false, message: 'Network error.' }));
          btn.disabled = false; form.querySelector('.sf-msg').textContent = r.ok ? 'Saved.' : '';
          if (!r.ok) { show(g, issuesToErrors(g, r.issues || []), r.message || ''); return; }
          if (typeof TK !== 'undefined' && TK.toast) TK.toast('Saved.');
        });
      }
    }
    /** values: the document; placeholders: what a blank (nullable) field resolves to now. */
    function fill(groups, values, placeholders) {
      for (const g of groups) for (const f of g.fields) {
        const el = document.getElementById(idOf(g, f));
        if (!el) continue;
        const v = get(values, f.path);
        if (f.kind === 'bool') el.value = v === true ? 'true' : v === false ? 'false' : '';
        else if (f.kind === 'list') el.value = Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
        else el.value = v == null ? '' : String(v);
        const ph = placeholders ? get(placeholders, f.path) : undefined;
        if (f.kind === 'bool' && f.nullable && el.options[0]) el.options[0].textContent = 'env / default' + (ph != null ? ' (' + (ph ? 'on' : 'off') + ')' : '');
        else if (ph != null && f.kind !== 'select') el.placeholder = Array.isArray(ph) ? ph.join(', ') : String(ph);
      }
    }
    function read(g) {
      const patch = {}, errors = {};
      for (const f of g.fields) {
        const el = document.getElementById(idOf(g, f));
        if (!el) continue;
        const raw = el.value.trim();
        if (f.kind === 'bool') { if (raw === '') { if (f.nullable) put(patch, f.path, null); } else put(patch, f.path, raw === 'true'); continue; }
        if (f.kind === 'select') {
          if (raw === '') { if (f.nullable) put(patch, f.path, null); continue; }
          if (f.options && !f.options.some((o) => o.value === raw)) { errors[f.path] = 'Pick one of the choices.'; continue; }
          put(patch, f.path, raw); continue;
        }
        if (f.kind === 'text') {
          if (raw === '') { if (f.nullable) put(patch, f.path, null); else errors[f.path] = 'Required.'; continue; }
          if (f.maxLength && raw.length > f.maxLength) { errors[f.path] = 'At most ' + f.maxLength + ' characters.'; continue; }
          put(patch, f.path, raw); continue;
        }
        if (f.kind === 'list') {
          const items = raw.split(',').map((x) => x.trim()).filter(Boolean);
          if (f.maxLength && items.some((x) => x.length > f.maxLength)) { errors[f.path] = 'Each at most ' + f.maxLength + ' characters.'; continue; }
          if (f.max != null && items.length > f.max) { errors[f.path] = 'At most ' + f.max + ' items.'; continue; }
          put(patch, f.path, items); continue;
        }
        if (raw === '') { if (f.nullable) put(patch, f.path, null); continue; } // blank non-nullable: left as it is (e.g. an older tlpool without the key)
        const n = Number(raw);
        if (!Number.isFinite(n)) { errors[f.path] = 'Not a number.'; continue; }
        if (f.min != null && n < f.min) { errors[f.path] = 'At least ' + f.min + '.'; continue; }
        if (f.max != null && n > f.max) { errors[f.path] = 'At most ' + f.max + '.'; continue; }
        if (f.step === 1 && !Number.isInteger(n)) { errors[f.path] = 'A whole number.'; continue; }
        put(patch, f.path, n);
      }
      return { patch, errors };
    }
    /** zod "a.b: msg" or tlpool "key must be ..." -> the field it names. */
    function issuesToErrors(g, issues) {
      const out = {};
      for (const s of issues) {
        const f = g.fields.find((x) => s.startsWith(x.path + ':') || s.startsWith(x.path.split('.').pop() + ' '));
        if (f) out[f.path] = s.slice(s.indexOf(':') >= 0 && s.startsWith(f.path + ':') ? f.path.length + 1 : 0).trim();
        else out['_'] = (out['_'] ? out['_'] + '; ' : '') + s;
      }
      return out;
    }
    function show(g, errors, formMsg) {
      const form = document.getElementById(g.id);
      for (const fl of form.querySelectorAll('.sf-field')) {
        const e = errors[fl.dataset.path];
        fl.classList.toggle('bad', !!e);
        fl.querySelector('.sf-err').textContent = e || '';
      }
      form.querySelector('.sf-form-err').textContent = [errors['_'], formMsg].filter(Boolean).join(' ');
    }
    return { mount, fill, read, get, put };
  })();
`
