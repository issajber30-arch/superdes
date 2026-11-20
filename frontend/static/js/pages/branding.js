// Branding editor (owner), Stitch "White-Label Studio Branding Settings": studio profile + logo, aesthetic system
// (palette presets that fill the colour pickers, colours, font, layout template), the mandatory disclaimer, and a
// live client viewport preview. Only fields the API stores are offered.
import { api, apiUrl, errorText, PREVIEW } from '../api.js';
import { h, field, notice, busy, select, toast } from '../dom.js';
import { icon } from '../icons.js';
import { session, isOwner, applyBranding, FONTS, TEMPLATES, validHex } from '../state.js';
import { refreshSession } from '../app.js';
import { CAVEAT } from '../editor/svg-editor.js';

// Stitch's three palette cards, as values for the primary / accent / background pickers
const PRESETS = [
  ['Architectural slate', 'Dark slate grounding with warm parchment and cyan accents.', '#1e232a', '#0284c7', '#faf9f6'],
  ['Honed travertine', 'Earthy umber and limestone neutrals.', '#381c00', '#b28052', '#ffffff'],
  ['Nordic monolith', 'High-contrast monochrome.', '#2f312f', '#75777b', '#faf9f6']];
const TEMPLATE_NOTES = { classic: 'Serif headings', modern: 'Default layout', minimal: 'Flat, no shadows' };

export async function brandingPage(main) {
  const page = h('section', { class: 'page wide' });
  main.append(page);
  if (!isOwner()) { page.append(h('h1', null, 'Studio branding'), h('p', { class: 'notice notice-info' }, 'Only the studio owner can change branding.')); return; }
  let b = await api('/studio/branding');
  const slug = session.me.studio.slug;
  const studioName = session.me.studio.name;
  const err = notice();
  const name = h('input', { type: 'text', maxlength: 100, value: b.display_name || '', placeholder: studioName });
  const color = (v, label) => h('input', { type: 'color', value: validHex(v) ? v : '#000000', 'aria-label': label });
  const primary = color(b.primary_color, 'Primary colour'); const accent = color(b.accent_color, 'Accent colour'); const bg = color(b.background_color, 'Background colour');
  const font = select(Object.entries(FONTS).map(([k, [label]]) => [k, label]), b.font);
  let template = TEMPLATES.includes(b.template) ? b.template : 'modern';
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });

  const current = () => ({ display_name: name.value.trim(), primary_color: primary.value, accent_color: accent.value, background_color: bg.value, font: font.value, template });
  const logoUrl = () => apiUrl(`/public/studios/${encodeURIComponent(slug)}/logo?v=${encodeURIComponent(b.updated_at || Date.now())}`);
  const mark = (dark) => {
    const tile = h('div', { class: `mark-tile ${dark ? 'dark' : ''}` });
    tile.replaceChildren(b.logo_upload_id ? h('img', { src: logoUrl(), alt: `${dark ? 'Logo on dark' : 'Logo on light'}` }) : h('span', null, (current().display_name || studioName).toUpperCase()));
    return tile;
  };
  const marks = h('div', { class: 'row gap' });
  const drawMarks = () => marks.replaceChildren(mark(true), mark(false));

  // ---------- live client viewport ----------
  const pvName = h('span', { class: 'pv-name' });
  const pvLogo = h('div', { class: 'pv-logo' });
  const preview = h('div', { class: 'pv-body', 'aria-label': 'Live preview of the client view' },
    h('div', { class: 'pv-bar' }, h('div', { class: 'row gap-sm min0' }, pvLogo, pvName), h('span', { class: 'label-mono flat' }, 'Client view')),
    h('span', { class: 'pv-chip' }, 'Dossier submitted · in review'),
    h('h3', { class: 'pv-title' }, 'Your living room concept'),
    h('p', { class: 'pv-text' }, 'Welcome — let’s plan your living room together.'),
    h('div', { class: 'pv-tiles' }, h('div', null, h('span', { class: 'label-mono flat' }, 'Material finishes'), h('strong', null, '6 specified')), h('div', null, h('span', { class: 'label-mono flat' }, 'Plan'), h('strong', null, 'Version 2'))),
    h('div', { class: 'row gap-sm' }, h('span', { class: 'pv-btn' }, 'Primary action'), h('span', { class: 'pv-accent' }, 'Accent')),
    h('p', { class: 'pv-foot' }, CAVEAT));
  const updatePreview = () => {
    const c = current();
    pvName.textContent = c.display_name || studioName;
    pvLogo.replaceChildren(b.logo_upload_id ? h('img', { src: logoUrl(), alt: '' }) : h('span', null, (c.display_name || studioName).trim().charAt(0).toUpperCase() || 'S'));
    for (const [prop, val] of [['--brand-primary', c.primary_color], ['--brand-accent', c.accent_color], ['--brand-bg', c.background_color]]) {
      if (validHex(val)) preview.style.setProperty(prop, val);
    }
    if (FONTS[c.font]) preview.style.setProperty('--brand-font', FONTS[c.font][1]);
    preview.dataset.template = c.template;
    quote.style.setProperty('font-family', FONTS[c.font] ? FONTS[c.font][1] : '');
    presetCards.forEach((card, i) => card.setAttribute('aria-pressed', String(PRESETS[i].slice(2).join() === [c.primary_color, c.accent_color, c.background_color].join())));
    tplBtns.forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.t === c.template)));
    drawMarks();
  };

  // ---------- aesthetic system ----------
  const presetCards = PRESETS.map(([label, note, p, a, g]) => {
    const sw = (hex) => { const d = h('div'); d.style.setProperty('background', hex); return d; };
    return h('button', { type: 'button', class: 'preset', 'aria-pressed': 'false', onclick: () => { primary.value = p; accent.value = a; bg.value = g; updatePreview(); } },
      h('div', { class: 'row between' }, h('span', { class: 'strong' }, label), h('span', { class: 'dot' })),
      h('div', { class: 'preset-swatches' }, sw(p), sw(g), sw(a)),
      h('span', { class: 'label-mono flat' }, note));
  });
  const tplBtns = TEMPLATES.map((t) => h('button', { type: 'button', class: 'tpl-btn', 'data-t': t, 'aria-pressed': 'false', onclick: () => { template = t; updatePreview(); } },
    h('span', { class: 'strong' }, t[0].toUpperCase() + t.slice(1)), h('span', { class: 'label-mono flat' }, TEMPLATE_NOTES[t] || '')));
  const quote = h('blockquote', { class: 'type-sample' }, '“A calm, warm home — designed around how you live.”');

  [name, primary, accent, bg, font].forEach((el) => el.addEventListener('input', updatePreview));
  font.addEventListener('change', updatePreview);

  const saved = { ...current() };
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-small' }, icon('check_circle', 16), 'Save changes');
  saveBtn.setAttribute('form', 'branding-form'); // sits in the banner, outside the form (Stitch layout)
  const reset = h('button', { type: 'button', class: 'btn btn-soft btn-small', onclick: () => {
    name.value = saved.display_name; primary.value = saved.primary_color; accent.value = saved.accent_color; bg.value = saved.background_color; font.value = saved.font; template = saved.template; updatePreview();
  } }, icon('undo', 16), 'Reset');
  const form = h('form', { class: 'stack-lg', id: 'branding-form' });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.clear();
    const c = current();
    if (![c.primary_color, c.accent_color, c.background_color].every(validHex)) { err.show('Colours must be #RRGGBB values.'); return; }
    if (!c.display_name) delete c.display_name;
    busy(saveBtn, async () => {
      try {
        b = await api('/studio/branding', { method: 'PUT', body: c });
        Object.assign(saved, current());
        await refreshSession();
        applyBranding(session.branding);
        toast('Branding saved');
      } catch (ex) { err.show(errorText(ex)); }
    });
  });

  // ---------- logo upload ----------
  const upErr = notice();
  const upBtn = h('button', { type: 'button', class: 'btn btn-soft btn-small' }, 'Upload logo');
  upBtn.addEventListener('click', () => {
    const f = file.files[0];
    upErr.clear();
    if (!f) { upErr.show('Choose an image first.'); return; }
    if (f.size > 10 * 1024 * 1024) { upErr.show('The logo must be 10 MB or smaller.'); return; }
    const fd = new FormData();
    fd.append('file', f);
    busy(upBtn, async () => {
      try {
        b = await api('/studio/branding/logo', { method: 'POST', form: fd });
        updatePreview();
        await refreshSession();
        toast('Logo updated');
      } catch (ex) { upErr.show(errorText(ex)); }
    });
  });

  const section = (ic, title, desc, chip, ...body) => h('section', { class: 'sheet-card' },
    h('div', { class: 'row between gap-sm' }, h('div', { class: 'row gap-sm align-start' }, h('span', { class: 'secondary-text' }, icon(ic, 20)),
      h('div', null, h('h2', { class: 'section-title' }, title), h('p', { class: 'muted small flat' }, desc))), chip ? h('span', { class: 'code-chip' }, chip) : null),
    ...body);
  form.append(
    section('architecture', 'Studio profile & signature mark', 'Shown to clients on your studio link, their projects and dossiers.', 'Profile',
      h('div', { class: 'two-col' }, field('Studio display name', name, `Leave empty to use “${studioName}”.`),
        h('div', { class: 'stack-xs' }, h('span', { class: 'label-mono flat' }, 'Studio link'), h('code', { class: 'link-box' }, PREVIEW ? 'Off in personal preview' : `#/s/${slug}`))),
      h('div', { class: 'soft-box asset-strip' },
        h('div', { class: 'stack-xs' }, h('span', { class: 'label-mono flat' }, 'Studio signature mark'), marks, h('span', { class: 'label-mono flat' }, 'PNG, JPEG, WEBP or GIF, max 10 MB. Transparent PNG works best.')),
        h('div', { class: 'stack-xs' }, field('Logo image', file), upBtn, upErr))),
    section('palette', 'Aesthetic system', 'Colour, type and layout your clients see.', 'Tokens',
      h('div', { class: 'preset-grid' }, presetCards),
      h('div', { class: 'row gap wrap' }, field('Primary colour', primary), field('Accent colour', accent), field('Background colour', bg)),
      h('div', { class: 'two-col' },
        h('div', { class: 'soft-box stack-sm' }, field('Client type family', font, 'Used if installed on the viewer’s device, with a matching fallback.'), quote),
        h('div', { class: 'soft-box stack-sm' }, h('span', { class: 'label-mono flat' }, 'Layout template'), h('div', { class: 'tpl-row', role: 'group', 'aria-label': 'Layout template' }, tplBtns)))),
    section('verified_user', 'Conceptual disclaimer', 'Always shown to clients on plans, renders, estimates and dossiers.', 'Mandatory',
      h('div', { class: 'note-row' }, h('span', { class: 'warm-text' }, icon('gavel', 16)), h('span', null, CAVEAT))),
    err);

  page.append(
    h('div', { class: 'dash-banner' },
      h('div', { class: 'row gap min0' }, h('div', { class: 'dash-banner-icon', 'aria-hidden': 'true' }, icon('verified_user', 20)),
        h('div', { class: 'min0' }, h('div', { class: 'row gap-sm wrap' }, h('h1', null, 'Studio branding'), h('span', { class: 'chip-dark' }, 'White label')),
          h('p', { class: 'muted small' }, 'Your name, logo, colours and type on everything your clients see.'))),
      h('div', { class: 'row gap-sm wrap' }, reset,
        PREVIEW ? null : h('a', { class: 'btn btn-soft btn-small', href: `#/s/${slug}`, target: '_blank', rel: 'noopener' }, icon('visibility', 16), 'Client view'),
        saveBtn)),
    h('div', { class: 'branding-grid' }, form,
      h('div', { class: 'branding-side' },
        h('div', { class: 'sheet-card' }, h('div', { class: 'row gap-sm' }, h('span', { class: 'dot tone-secondary pulse' }), h('span', { class: 'strong' }, 'Live client viewport')),
          h('div', { class: 'browser' }, h('div', { class: 'browser-bar' }, h('span', { class: 'traffic' }, h('i'), h('i'), h('i')),
            h('span', { class: 'url' }, icon('lock', 12), PREVIEW ? 'personal preview' : `${location.host}/#/s/${slug}`)), preview)),
        h('div', { class: 'soft-box' }, h('span', { class: 'row gap-sm strong' }, icon('info', 16), 'Where clients see this'),
          h('p', { class: 'muted small flat' }, PREVIEW ? 'Client links are off in personal preview.' : 'On your studio link, in their projects, and on every dossier you generate.')))));
  updatePreview();
}
