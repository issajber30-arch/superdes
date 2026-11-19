// Collaboration: comments, concept decisions, tasks and messages.
import { api, errorText } from '../api.js';
import { h, field, notice, busy, select, fmtDate, toast, badge } from '../dom.js';

export async function render(el, ctx) {
  const { base, project, staff } = ctx;
  const people = project.people || [];
  const nameOf = (id) => { const p = people.find((x) => x.id === id); return p ? (p.display_name || p.email) : '—'; };
  const versions = (await api(`${base}/plan/versions`)).versions;
  const vOpts = versions.map((v) => [v.version_no, `v${v.version_no}${v.label ? ` — ${v.label}` : ''}`]);
  let alive = true;
  let timer = null;

  // --- comments + decisions ---
  const commentList = h('ul', { class: 'thread' });
  const cFilter = select([['', 'All versions'], ...vOpts], '');
  async function loadComments() {
    const res = await api(`${base}/comments${cFilter.value ? `?plan_version_no=${cFilter.value}` : ''}`);
    commentList.replaceChildren(...(res.comments.length ? res.comments.map((c) => h('li', null,
      h('div', { class: 'muted small' }, `${c.author_name || 'Someone'} · v${c.plan_version_no}${c.element_id ? ` · on ${c.element_id}` : ''} · ${fmtDate(c.created_at)}`),
      h('p', null, c.body))) : [h('li', { class: 'muted' }, 'No comments yet.')]));
  }
  cFilter.addEventListener('change', () => loadComments().catch((ex) => toast(errorText(ex), 'error')));
  const cBody = h('textarea', { rows: 3, maxlength: 5000, required: true });
  const cVer = select(vOpts, versions[0].version_no);
  const cEl = h('input', { type: 'text', maxlength: 64, placeholder: 'optional, e.g. w1t' });
  const cErr = notice();
  const cBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-small' }, 'Post comment');
  const cForm = h('form', { class: 'form' }, field('Comment', cBody), h('div', { class: 'row gap wrap' }, field('Plan version', cVer), field('Element id', cEl, 'Shown in the Plan tab element list.')), cBtn, cErr);
  cForm.addEventListener('submit', (e) => {
    e.preventDefault();
    cErr.clear();
    if (!cBody.value.trim()) { cErr.show('Write a comment first.'); return; }
    const body = { body: cBody.value.trim(), plan_version_no: Number(cVer.value) };
    if (cEl.value.trim()) body.element_id = cEl.value.trim();
    busy(cBtn, async () => { try { await api(`${base}/comments`, { method: 'POST', body }); cBody.value = ''; cEl.value = ''; await loadComments(); } catch (ex) { cErr.show(errorText(ex)); } });
  });

  const decList = h('ul', { class: 'thread' });
  async function loadDecisions() {
    const res = await api(`${base}/decisions`);
    decList.replaceChildren(...(res.decisions.length ? res.decisions.map((d) => h('li', null,
      h('div', { class: 'row gap wrap' }, badge(d.decision.replace('_', ' '), d.decision === 'concept_approved' ? 'ok' : 'warn'), h('span', { class: 'muted small' }, `v${d.plan_version_no} · ${d.decided_role} · ${fmtDate(d.created_at)}`)),
      d.note ? h('p', null, d.note) : null)) : [h('li', { class: 'muted' }, 'No decisions yet.')]));
  }
  const dVer = select(vOpts, versions[0].version_no);
  const dNote = h('input', { type: 'text', maxlength: 2000 });
  const decide = (decision) => async (e) => {
    const body = { plan_version_no: Number(dVer.value), decision };
    if (dNote.value.trim()) body.note = dNote.value.trim();
    try { await busy(e.currentTarget, () => api(`${base}/decisions`, { method: 'POST', body })); dNote.value = ''; await loadDecisions(); } catch (ex) { toast(errorText(ex), 'error'); }
  };

  // --- tasks ---
  const taskList = h('div');
  const assigneeOpts = [['', 'Unassigned'], ...people.map((p) => [p.id, `${p.display_name || p.email} (${p.role})`])];
  async function loadTasks() {
    const res = await api(`${base}/tasks`);
    taskList.replaceChildren(res.tasks.length ? h('ul', { class: 'tasks' }, res.tasks.map((t) => {
      const st = select([['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']], t.status, { 'aria-label': `Status of ${t.title}` });
      const as = select(assigneeOpts, t.assignee_id || '', { 'aria-label': `Assignee of ${t.title}` });
      const patch = (body) => api(`${base}/tasks/${t.id}`, { method: 'PATCH', body }).then(loadTasks).catch((ex) => toast(errorText(ex), 'error'));
      st.addEventListener('change', () => patch({ status: st.value }));
      as.addEventListener('change', () => patch({ assignee_id: as.value || null }));
      return h('li', { class: `task task-${t.status}` },
        h('span', { class: 'task-title' }, t.title), st, as,
        staff ? h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: async (e) => {
          try { await busy(e.currentTarget, () => api(`${base}/tasks/${t.id}`, { method: 'DELETE' })); loadTasks(); } catch (ex) { toast(errorText(ex), 'error'); }
        } }, 'Delete') : null);
    })) : h('p', { class: 'muted' }, 'No tasks yet.'));
  }
  const tTitle = h('input', { type: 'text', maxlength: 200, required: true });
  const tAs = select(assigneeOpts, '');
  const tBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-small' }, 'Add task');
  const tErr = notice();
  const tForm = h('form', { class: 'row gap wrap align-end' }, field('New task', tTitle), field('Assign to', tAs), tBtn, tErr);
  tForm.addEventListener('submit', (e) => {
    e.preventDefault();
    tErr.clear();
    if (!tTitle.value.trim()) { tErr.show('Enter a task title.'); return; }
    const body = { title: tTitle.value.trim() };
    if (tAs.value) body.assignee_id = tAs.value;
    busy(tBtn, async () => { try { await api(`${base}/tasks`, { method: 'POST', body }); tTitle.value = ''; await loadTasks(); } catch (ex) { tErr.show(errorText(ex)); } });
  });

  // --- messages (polled) ---
  const msgList = h('ul', { class: 'messages', 'aria-live': 'polite' });
  let last = null;
  async function pollMessages() {
    try {
      const res = await api(`${base}/messages${last ? `?after=${encodeURIComponent(last)}` : ''}`);
      if (!last && !res.messages.length) msgList.replaceChildren(h('li', { class: 'muted empty' }, 'No messages yet.'));
      if (res.messages.length) {
        const empty = msgList.querySelector('.empty');
        if (empty) empty.remove();
        msgList.append(...res.messages.map((m) => h('li', null, h('div', { class: 'muted small' }, `${m.author_name || nameOf(m.author_id)} · ${fmtDate(m.created_at)}`), h('p', null, m.body))));
        last = res.messages[res.messages.length - 1].created_at;
        msgList.scrollTop = msgList.scrollHeight;
      }
    } catch { /* keep polling */ }
    if (alive) timer = setTimeout(pollMessages, 5000);
  }
  const mBody = h('textarea', { rows: 2, maxlength: 5000, required: true });
  const mBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-small' }, 'Send');
  const mErr = notice();
  const mForm = h('form', { class: 'form' }, field('Message', mBody), mBtn, mErr);
  mForm.addEventListener('submit', (e) => {
    e.preventDefault();
    mErr.clear();
    if (!mBody.value.trim()) { mErr.show('Write a message first.'); return; }
    busy(mBtn, async () => {
      try { await api(`${base}/messages`, { method: 'POST', body: { body: mBody.value.trim() } }); mBody.value = ''; clearTimeout(timer); await pollMessages(); } catch (ex) { mErr.show(errorText(ex)); }
    });
  });

  el.append(h('div', { class: 'collab' },
    h('section', { class: 'card' }, h('h2', null, 'Messages'), msgList, mForm),
    h('section', { class: 'card' }, h('h2', null, 'Tasks'), taskList, tForm),
    h('section', { class: 'card' }, h('div', { class: 'row gap wrap spread' }, h('h2', null, 'Comments'), field('Show', cFilter)), commentList, cForm),
    h('section', { class: 'card' }, h('h2', null, 'Concept decisions'),
      h('p', { class: 'muted small' }, 'Records agreement on the design concept only — never approval for construction.'), decList,
      h('div', { class: 'row gap wrap align-end' }, field('Plan version', dVer), field('Note', dNote),
        h('button', { type: 'button', class: 'btn btn-small', onclick: decide('concept_approved') }, 'Approve concept'),
        h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: decide('changes_requested') }, 'Request changes')))));
  await Promise.all([loadComments(), loadDecisions(), loadTasks()]);
  pollMessages();
  return () => { alive = false; clearTimeout(timer); };
}
