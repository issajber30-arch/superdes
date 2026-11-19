// Branding editor (owner): name, logo, colors, font, template with live preview.
import { api, apiUrl, errorText, PREVIEW } from '../api.js';
import { h, field, notice, busy, select, toast } from '../dom.js';
import { session, isOwner, applyBranding, FONTS, TEMPLATES, validHex } from '../state.js';
import { refreshSession } from '../app.js';

export async function brandingPage(main) {
  const page = h('section', { class: 'page' }, h('h1', null, 'Studio branding'));
  main.append(page);
  if (!isOwner()) { page.append(h('p', { class: 'notice notice-info' }, 'Only the studio owner can change branding.')); return; }
  let b = await api('/studio/branding');
  const slug = session.me.studio.slug;
  const err = notice();
  const name = h('input', { type: 'text', maxlength: 100, value: b.display_name || '' });
  const color = (v) => h('input', { type: 'color', value: validHex(v) ? v : '#000000' });
  const primary = color(b.primary_color); const accent = color(b.accent_color); const bg = color(b.background_color);
  const font = select(Object.entries(FONTS).map(([k, [label]]) => [k, label]), b.font);
  const template = select(TEMPLATES.map((t) => [t, t]), b.template);
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
  const logoImg = h('img', { alt: 'Current logo', class: 'studio-logo' });
  const showLogo = () => {
    logoImg.hidden = !b.logo_upload_id;
    if (b.logo_upload_id) logoImg.src = apiUrl(`/public/studios/${encodeURIComponent(slug)}/logo?v=${encodeURIComponent(b.updated_at || Date.now())}`);
  };
  showLogo();

  const current = () => ({
    display_name: name.value.trim(), primary_color: primary.value, accent_color: accent.value,
    background_color: bg.value, font: font.value, template: template.value,
  });
  const previewName = h('h2', null);
  const preview = h('div', { class: 'brand-preview', 'aria-label': 'Live preview' },
    h('div', { class: 'brand-preview-bar' }, previewName),
    h('p', null, 'Welcome — let’s plan your living room together.'),
    h('div', { class: 'row gap' }, h('span', { class: 'btn btn-primary', 'aria-hidden': 'true' }, 'Primary action'), h('span', { class: 'badge badge-accent' }, 'Accent')));
  const updatePreview = () => {
    const c = current();
    previewName.textContent = c.display_name || session.me.studio.name;
    for (const [prop, val] of [['--brand-primary', c.primary_color], ['--brand-accent', c.accent_color], ['--brand-bg', c.background_color]]) {
      if (validHex(val)) preview.style.setProperty(prop, val);
    }
    if (FONTS[c.font]) preview.style.setProperty('--brand-font', FONTS[c.font][1]);
    preview.dataset.template = c.template;
  };
  [name, primary, accent, bg, font, template].forEach((el) => el.addEventListener('input', updatePreview));
  [font, template].forEach((el) => el.addEventListener('change', updatePreview));
  updatePreview();

  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save branding');
  const form = h('form', { class: 'card form' },
    field('Studio display name', name),
    h('div', { class: 'row gap wrap' }, field('Primary colour', primary), field('Accent colour', accent), field('Background colour', bg)),
    field('Font', font, 'Uses the font if installed on the viewer’s device, with a matching fallback.'),
    field('Template', template),
    saveBtn, err);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.clear();
    const c = current();
    if (![c.primary_color, c.accent_color, c.background_color].every(validHex)) { err.show('Colours must be #RRGGBB values.'); return; }
    if (!c.display_name) delete c.display_name;
    busy(saveBtn, async () => {
      try {
        b = await api('/studio/branding', { method: 'PUT', body: c });
        await refreshSession();
        applyBranding(session.branding);
        toast('Branding saved');
      } catch (ex) { err.show(errorText(ex)); }
    });
  });

  const upErr = notice();
  const upBtn = h('button', { type: 'button', class: 'btn' }, 'Upload logo');
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
        showLogo();
        await refreshSession();
        toast('Logo updated');
      } catch (ex) { upErr.show(errorText(ex)); }
    });
  });

  page.append(h('div', { class: 'split' },
    h('div', null, form,
      h('div', { class: 'card form' }, h('h2', null, 'Logo'), logoImg, field('Logo image (PNG, JPEG, WEBP or GIF, max 10 MB)', file), upBtn, upErr)),
    h('div', null, h('h2', null, 'Preview'), preview,
      PREVIEW ? null : h('p', { class: 'muted small' }, 'Clients see this branding on your studio link: ', h('a', { href: `#/s/${slug}` }, `#/s/${slug}`)))));
}
