import { h } from '../dom.js';
import { api, PREVIEW } from '../api.js';
import { session } from '../state.js';
import { go } from '../app.js';

export async function landingPage(main) {
  if (session.me && session.me.studio) { go('#/dashboard'); return; }
  const card = (title, text, href, cta, primary) => h('article', { class: 'choice' },
    h('h2', null, title), h('p', null, text), h('a', { href, class: `btn ${primary ? 'btn-primary' : ''}` }, cta));
  main.append(h('section', { class: 'page hero' },
    h('p', { class: 'eyebrow' }, 'AI-assisted interior design'),
    h('h1', null, 'Plan rooms, shape ideas and present concepts — together with your clients.'),
    h('p', { class: 'lead' }, 'Sketch a floor plan in minutes, explore styles and finishes with an AI consultant, request concept visualizations and share a branded design dossier.'),
    PREVIEW ? h('div', { class: 'choices' },
      (await api('/health').then((r) => r.setup_open, () => false))
        ? card('Create your studio', 'Set up your own studio. Personal preview: this first account is the only one.', '#/start', 'Create your studio', true) : null,
      card('Sign in', 'Continue your projects.', '#/login', 'Sign in', true)) : h('div', { class: 'choices' },
      card("I'm a designer", 'Create your studio, invite clients and run projects under your own brand.', '#/start', 'Create a studio', true),
      card('Just exploring', 'Try the plan wizard and editor without an account. Your plan stays in this browser until you save it.', '#/guest', 'Start a guest trial'),
      card('I have an account', 'Sign in to continue your projects.', '#/login', 'Sign in'))));
}
