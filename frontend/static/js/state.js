// Session state (current user), guest-trial storage and studio branding.
import { api, ApiError } from './api.js';

export const session = { me: null };

export async function loadMe() {
  try { session.me = await api('/auth/me'); } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    session.me = null;
  }
  return session.me;
}

export const isStaff = () => ['owner', 'designer'].includes(session.me && session.me.role);
export const isOwner = () => session.me && session.me.role === 'owner';

// --- guest trial: everything lives in this browser only ---
const GUEST_KEY = 'sd_guest_v1';
export function loadGuest() {
  try { return JSON.parse(localStorage.getItem(GUEST_KEY)) || null; } catch { return null; }
}
export function saveGuest(data) {
  try { localStorage.setItem(GUEST_KEY, JSON.stringify({ ...data, updated_at: new Date().toISOString() })); return true; } catch { return false; }
}
export function clearGuest() { try { localStorage.removeItem(GUEST_KEY); } catch { /* storage unavailable */ } }

// --- branding: values are validated server-side; re-validated here before touching CSS ---
const HEX = /^#[0-9a-fA-F]{6}$/;
export const FONTS = {
  inter: ['Inter', '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif'],
  lora: ['Lora', '"Lora", Georgia, "Times New Roman", serif'],
  playfair: ['Playfair Display', '"Playfair Display", Georgia, serif'],
  'source-sans': ['Source Sans', '"Source Sans 3", "Source Sans Pro", system-ui, sans-serif'],
  roboto: ['Roboto', 'Roboto, "Helvetica Neue", Arial, sans-serif'],
  merriweather: ['Merriweather', 'Merriweather, Georgia, serif'],
  system: ['System default', 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'],
};
export const TEMPLATES = ['classic', 'modern', 'minimal'];

export function applyBranding(b) {
  const root = document.documentElement;
  if (!b) {
    ['--brand-primary', '--brand-accent', '--brand-bg', '--brand-font'].forEach((p) => root.style.removeProperty(p));
    document.body.dataset.template = 'modern';
    return;
  }
  const set = (prop, val) => (HEX.test(val || '') ? root.style.setProperty(prop, val) : root.style.removeProperty(prop));
  set('--brand-primary', b.primary_color);
  set('--brand-accent', b.accent_color);
  set('--brand-bg', b.background_color);
  if (FONTS[b.font]) root.style.setProperty('--brand-font', FONTS[b.font][1]); else root.style.removeProperty('--brand-font');
  document.body.dataset.template = TEMPLATES.includes(b.template) ? b.template : 'modern';
}

export const validHex = (v) => HEX.test(v || '');
