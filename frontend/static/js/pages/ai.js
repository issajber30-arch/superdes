// AI consultant chat: advice + suggestion cards with accept/reject (preferences only).
import { api, errorText } from '../api.js';
import { h, field, notice, busy, select, badge, toast } from '../dom.js';
import { validHex } from '../state.js';

const NOTE = 'Suggestions are not applied to your plan automatically.';

export async function render(el, ctx) {
  const { base } = ctx;
  const [convs, prefs] = await Promise.all([api(`${base}/ai/conversations`), api(`${base}/ai/preferences`)]);
  const decisions = new Map(prefs.preferences.map((p) => [p.suggestion_id, p.decision]));
  let conversationId = convs.conversations.length ? convs.conversations[0].id : null;
  const log = h('div', { class: 'chat-log', 'aria-live': 'polite' });
  const err = notice();

  const suggestionCard = (sg) => {
    const state = h('span', { class: 'small' });
    const setState = (d) => { state.replaceChildren(d ? badge(d === 'accept' ? 'Accepted — saved as a preference' : 'Rejected — will be avoided', d === 'accept' ? 'ok' : '') : ''); };
    setState(decisions.get(sg.id));
    const decide = (decision) => async (e) => {
      try {
        await busy(e.currentTarget, () => api(`${base}/ai/suggestions/${sg.id}/feedback`, { method: 'POST', body: { decision } }));
        decisions.set(sg.id, decision);
        setState(decision);
      } catch (ex) { toast(errorText(ex), 'error'); }
    };
    const palette = sg.data && sg.data.palette && typeof sg.data.palette === 'object' ? Object.entries(sg.data.palette).filter(([, v]) => validHex(v)) : [];
    const color = sg.data && validHex(sg.data.color) ? sg.data.color : null;
    const sw = (hex, label) => { const x = h('span', { class: 'swatch', role: 'img', 'aria-label': label }); x.style.setProperty('background', hex); return x; };
    return h('article', { class: 'suggestion' },
      h('div', { class: 'row gap wrap' }, badge(sg.kind), h('h4', null, sg.title)),
      h('p', { class: 'small' }, sg.detail),
      palette.length || color ? h('div', { class: 'swatches' }, palette.map(([k, v]) => sw(v, `${k} ${v}`)), color ? sw(color, color) : null) : null,
      sg.data && sg.data.width_mm ? h('p', { class: 'muted small' }, `Size ${sg.data.width_mm}×${sg.data.depth_mm} mm — place it yourself from the Plan tab if you like it.`) : null,
      h('div', { class: 'row gap wrap' },
        h('button', { type: 'button', class: 'btn btn-small', onclick: decide('accept') }, 'Accept'),
        h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: decide('reject') }, 'Reject'), state));
  };
  const msgEl = (m) => h('div', { class: `msg msg-${m.role}` },
    h('div', { class: 'msg-meta muted small' }, m.role === 'user' ? 'You' : `Consultant${m.provider ? ` (${m.provider})` : ''}`),
    h('p', { class: 'msg-body' }, m.content),
    m.suggestions && m.suggestions.length ? h('div', { class: 'suggestions' }, m.suggestions.map(suggestionCard)) : null);

  async function loadConversation() {
    if (!conversationId) { log.replaceChildren(h('p', { class: 'muted' }, 'Ask about styles, materials, furniture or layout ideas for this project. The consultant uses your brief and current plan.')); return; }
    const res = await api(`${base}/ai/conversations/${conversationId}/messages`);
    log.replaceChildren(...res.messages.map(msgEl));
    log.scrollTop = log.scrollHeight;
  }

  const convSel = select([['', 'New conversation'], ...convs.conversations.map((c, i) => [c.id, `Conversation ${convs.conversations.length - i} (${c.message_count} messages)`])], conversationId || '');
  convSel.addEventListener('change', () => { conversationId = convSel.value || null; loadConversation().catch((ex) => err.show(errorText(ex))); });

  const input = h('textarea', { rows: 3, maxlength: 4000, required: true, placeholder: 'e.g. Which style would suit a bright living room with a small budget?' });
  const send = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Send');
  const form = h('form', { class: 'chat-form' }, field('Your question', input), send, err);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.clear();
    const message = input.value.trim();
    if (!message) { err.show('Type a question first.'); return; }
    busy(send, async () => {
      try {
        const body = { message };
        if (conversationId) body.conversation_id = conversationId;
        const res = await api(`${base}/ai/messages`, { method: 'POST', body });
        if (!conversationId) {
          conversationId = res.conversation_id;
          convSel.append(h('option', { value: conversationId }, 'Current conversation'));
          convSel.value = conversationId;
          log.replaceChildren();
        }
        log.append(msgEl(res.user_message), msgEl(res.message));
        if (res.note) log.append(h('p', { class: 'muted small' }, res.note));
        log.scrollTop = log.scrollHeight;
        input.value = '';
      } catch (ex) { err.show(errorText(ex)); }
    });
  });

  el.append(h('section', { class: 'card chat' },
    h('div', { class: 'row gap wrap spread' }, h('h2', null, 'AI design consultant'), field('Conversation', convSel)),
    h('p', { class: 'notice notice-info' }, `The consultant only advises. ${NOTE}`),
    log, form));
  await loadConversation();
}
