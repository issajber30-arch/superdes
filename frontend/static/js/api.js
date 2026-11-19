// Thin fetch wrapper for the SuperDes API. All calls send the session cookie.
export const API_URL = ((window.APP_CONFIG && window.APP_CONFIG.apiUrl) || 'http://localhost:8010').replace(/\/$/, '');
// Single-owner personal preview: no clients, invitations or guest trial.
export const PREVIEW = !!(window.APP_CONFIG && window.APP_CONFIG.previewMode);

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const apiUrl = (path) => API_URL + path;

export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, credentials: 'include', headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(API_URL + path, opts);
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection and try again.');
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const e = (data && data.error) || {};
    throw new ApiError(res.status, e.code || `http_${res.status}`, e.message || res.statusText || 'Request failed', e.details);
  }
  return data;
}

// Human-readable message for an error (422 details become "field: msg" lines).
export function errorText(err) {
  if (!(err instanceof ApiError)) return (err && err.message) || 'Something went wrong.';
  if (err.code === 'validation_error' && Array.isArray(err.details) && err.details.length) {
    return err.details.slice(0, 5).map((d) => `${(d.loc || []).filter((x) => x !== 'body').join('.')}: ${d.msg}`).join('\n');
  }
  const friendly = {
    unauthenticated: 'Your session has ended. Please sign in again.',
    invalid_credentials: 'Email or password is incorrect.',
    insufficient_credits: 'Your studio has no render credits left. Credits renew with your subscription.',
    email_taken: 'An account with this email already exists. Try signing in instead.',
    slug_taken: 'That studio link is already taken. Choose another.',
    rate_limited: 'Too many attempts. Please wait a few minutes and try again.',
    version_conflict: 'Someone saved a newer version meanwhile. Reload the plan to continue from the latest version.',
    invitation_invalid: 'This invitation has expired, was already used, or was revoked.',
    csrf_origin_rejected: 'This page is not allowed to talk to the API (origin not configured).',
    too_large: 'That file is too large (max 10 MB).',
    invalid_image: 'That file is not a supported image (PNG, JPEG, WEBP or GIF).',
    no_studio: 'Your account is not part of a studio yet.',
  };
  return friendly[err.code] || err.message;
}

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);
