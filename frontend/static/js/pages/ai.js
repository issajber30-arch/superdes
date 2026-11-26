// AI consultant (Stitch studio, right column): advisory chat with suggestion cards (accept/reject = preferences only),
// conversation picker, quick consultation prompts and the input bar.
import { api, errorText } from '../api.js';
import { h, notice, busy, select, badge, toast, fmtDate } from '../dom.js';
import { icon } from '../icons.js';
import { validHex } from '../state.js';
import { polygonArea } from '../editor/svg-editor.js';

const NOTE = 'Suggestions are not applied to your plan automatically.';

/** Right column. data: {convs, prefs, plan, brief} */
export async function renderConsultant(el, ctx, data) {
  const { base } = ctx;
  const { convs, prefs } = data;
  const decisions = new Map(prefs.preferences.map((p) => [p.suggestion_id, p.decision]));
  let conversationId = convs.conversations.length ? convs.conversations[0].id : null;
  const log = h('div', { class: 'chat-stream', 'aria-live': 'polite' });
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
    return h('article', { class: 'suggestion-box' },
      h('div', { class: 'row gap-sm wrap' }, h('span', { class: 'secondary-text' }, icon('wand_stars', 16)), h('span', { class: 'label-mono flat' }, sg.kind), h('h4', null, sg.title)),
      h('p', { class: 'small' }, sg.detail),
      palette.length || color ? h('div', { class: 'swatches' }, palette.map(([k, v]) => sw(v, `${k} ${v}`)), color ? sw(color, color) : null) : null,
      sg.data && sg.data.width_mm ? h('p', { class: 'muted small' }, `Size ${sg.data.width_mm}×${sg.data.depth_mm} mm — place it yourself from the Plan tab if you like it.`) : null,
      h('div', { class: 'row gap-sm wrap' },
        h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: decide('accept') }, 'Accept'),
        h('button', { type: 'button', class: 'btn btn-small btn-soft', onclick: decide('reject') }, 'Reject'), state));
  };
  const time = (m) => (m.created_at ? fmtDate(m.created_at) : '');
  const msgEl = (m) => h('div', { class: `turn turn-${m.role}` },
    h('div', { class: 'turn-meta' }, h('span', { class: 'strong' }, m.role === 'user' ? 'You' : `Consultant${m.provider ? ` (${m.provider})` : ''}`), h('span', null, time(m))),
    h('div', { class: 'bubble' }, h('p', null, m.content),
      m.suggestions && m.suggestions.length ? h('div', { class: 'suggestions' }, m.suggestions.map(suggestionCard)) : null));

  async function loadConversation() {
    if (!conversationId) { log.replaceChildren(h('p', { class: 'muted small' }, 'Ask how to use the app, about pricing, or for design ideas for this project. Design advice uses your brief and current plan.')); return; }
    const res = await api(`${base}/ai/conversations/${conversationId}/messages`);
    log.replaceChildren(...res.messages.map(msgEl));
    log.scrollTop = log.scrollHeight;
  }

  const convSel = select([['', 'New conversation'], ...convs.conversations.map((c, i) => [c.id, `Conversation ${convs.conversations.length - i} (${c.message_count} messages)`])], conversationId || '');
  convSel.setAttribute('aria-label', 'Conversation');
  convSel.addEventListener('change', () => { conversationId = convSel.value || null; loadConversation().catch((ex) => err.show(errorText(ex))); });

  const input = h('textarea', { rows: 1, maxlength: 4000, required: true, 'aria-label': 'Your question', placeholder: 'Ask about the app, pricing or design…' });
  const send = h('button', { type: 'submit', class: 'send-btn', title: 'Send', 'aria-label': 'Send' }, icon('send', 18));
  const form = h('form', { class: 'ask-bar' }, input, send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !e.shiftKey)) { e.preventDefault(); form.requestSubmit(); } });
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

  // quick prompts built from this project's own rooms and brief; clicking one asks it
  const rooms = data.plan.current_version.geometry.rooms || [];
  const biggest = rooms.slice().sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon))[0];
  const prompts = [
    data.brief.styles.length ? `Which finishes suit a ${data.brief.styles[0]} style?` : 'Which style would suit this home?',
    biggest ? `Furniture ideas for the ${(biggest.name || biggest.kind).toLowerCase()}` : 'What should I put in the living room?',
    'How can I keep this within budget?'];
  const quick = h('div', { class: 'stack-xs' }, h('span', { class: 'label-mono flat' }, 'Suggested consultations'),
    prompts.map((p) => h('button', { type: 'button', class: 'prompt-btn', onclick: () => { input.value = p; form.requestSubmit(); } }, h('span', null, p), icon('chevron_right', 16))));

  el.append(
    h('div', { class: 'row between' },
      h('div', { class: 'row gap-sm' }, h('div', { class: 'consult-icon', 'aria-hidden': 'true' }, icon('psychology', 18)),
        h('div', null, h('h2', { class: 'col-title-sm' }, 'AI design consultant'), h('span', { class: 'label-mono flat' }, 'Advisory only'))),
      h('span', { class: 'dot tone-secondary', title: 'Online' })),
    h('div', { class: 'advisory' }, h('span', { class: 'warm-text' }, icon('verified_user', 16)),
      h('p', null, h('strong', null, 'Strictly advisory: '), `The consultant only advises. ${NOTE}`)),
    convSel, log, quick, form, err);
  await loadConversation();
}
