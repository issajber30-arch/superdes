// README media capture: records docs/demo (webm -> convert with ffmpeg) and the docs/screens stills from a running
// non-preview copy of the app at http://localhost:5181 (API on :8021) with a fresh demo studio. Test data only.
// Usage: PW=<path to node_modules/playwright> OUT=<empty dir> node docs/capture.cjs
// Then:  ffmpeg -i $OUT/demo.webm -vf "scale=1100:600,fps=12" -c:v libx264 -crf 28 -pix_fmt yuv420p -an docs/demo/superdes-demo.mp4
//        ffmpeg -i $OUT/demo.webm -vf "fps=5,scale=900:-1,split[a][b];[a]palettegen=max_colors=48:stats_mode=diff[p];[b][p]paletteuse=dither=none" docs/demo/superdes-demo.gif
const { chromium } = require(process.env.PW);
const U = 'http://localhost:5181';
const OUT = process.env.OUT;
const pause = (p, ms) => p.waitForTimeout(ms);
(async () => {
  const b = await chromium.launch();
  const errs = [];
  // ---- demo account + studio (API, inside the page so the session cookie is set) ----
  const setup = await (await b.newContext()).newPage();
  await setup.goto(U + '/');
  const creds = { email: `demo${Date.now()}@uitest.test`, password: 'Demo-' + Math.random().toString(36).slice(2) + 'Aa1' };
  await setup.evaluate(async (c) => {
    const m = await import('/js/api.js');
    await m.api('/auth/register', { method: 'POST', body: { ...c, display_name: 'Maya Laurent' } });
    await m.api('/studios', { method: 'POST', body: { name: 'Atelier Nord', slug: `atelier-nord-${Date.now() % 100000}` } });
  }, creds);
  const login = async (p) => { await p.goto(U + '/#/login'); await p.fill('input[type=email]', creds.email); await p.fill('input[type=password]', creds.password); await p.click('form button[type=submit]'); await pause(p, 1200); };

  // ---- demo video: 1320x720, scaled to 1100x600 afterwards ----
  const vctx = await b.newContext({ viewport: { width: 1320, height: 720 }, recordVideo: { dir: OUT + '/video', size: { width: 1320, height: 720 } } });
  const v = await vctx.newPage();
  v.on('pageerror', (e) => errs.push(String(e)));
  await login(v);
  await v.goto(U + '/#/dashboard'); await pause(v, 1500);
  await v.click('.dash-banner .btn-primary'); await pause(v, 800);
  await v.locator('.dash > .card input[type=text]').first().pressSequentially('Riverside Apartment', { delay: 60 }); await pause(v, 600);
  await v.getByRole('button', { name: 'Create project' }).click(); await v.waitForURL(/\/plan$/); await pause(v, 2200);
  await v.selectOption('.catalog select', 'seating'); await pause(v, 700);
  await v.locator('.catalog-item').first().click(); await pause(v, 900);
  await v.locator('.plan-svg').focus(); for (let i = 0; i < 32; i++) { await v.keyboard.press('ArrowLeft'); await pause(v, 25); } for (let i = 0; i < 12; i++) { await v.keyboard.press('ArrowDown'); await pause(v, 25); } await pause(v, 900);
  await v.locator('input[placeholder^="e.g. Moved"]').pressSequentially('Added sofa', { delay: 60 });
  await v.getByRole('button', { name: 'Save version' }).click(); await pause(v, 2200);
  const pid = v.url().match(/#\/p\/([^/]+)/)[1];
  await v.evaluate(async (pid) => { const m = await import('/js/api.js'); // a brief makes the consultant and budget meaningful
    await m.api(`/projects/${pid}/brief`, { method: 'PUT', body: { styles: ['japandi'], colors: ['warm white', 'oak'], materials: ['linen', 'oak'], budget: { min: 6000, max: 12000, currency: 'EUR', priority: 'balanced' },
      functional_needs: ['home office corner', 'more storage'], lifestyle: ['cooks often'], constraints: ['Rented flat — no structural changes'], household: { adults: 2, children: 0, pets: ['cat'], works_from_home: true, accessibility_needs: '' },
      notes: 'We love calm, warm spaces. Please keep the existing oak floor.' } }); }, pid);
  await v.click('.rail a[href$="/ai"]'); await pause(v, 2500);
  await v.locator('.prompt-btn').first().click(); await v.waitForSelector('.turn-assistant', { timeout: 20000 }); await pause(v, 2500);
  await v.selectOption('.render-controls .param:nth-child(3) select', 'japandi'); await pause(v, 600);
  await v.locator('.render-bar button[type=submit]').click();
  await v.waitForSelector('.concept-img img', { timeout: 30000 }); await pause(v, 2500);
  await v.click('.rail a[href$="/budget"]'); await pause(v, 2500);
  await v.mouse.wheel(0, 500); await pause(v, 1500); await v.mouse.wheel(0, 500); await pause(v, 2500);
  const video = v.video(); await vctx.close(); await video.saveAs(OUT + '/demo.webm');

  // ---- more realistic data for the stills ----
  await setup.evaluate(async (pid) => {
    const m = await import('/js/api.js'); const base = `/projects/${pid}`;
    const plan = await m.api(`${base}/plan`); const rooms = plan.current_version.geometry.rooms;
    const floors = (await m.api('/catalog/finishes?surface=floor')).finishes; const walls = (await m.api('/catalog/finishes?surface=wall')).finishes;
    const pick = (list, re) => (list.find((f) => re.test(f.name)) || list[0]).key;
    for (const r of rooms) {
      await m.api(`${base}/finishes`, { method: 'PUT', body: { room_id: r.id, surface: 'floor', finish_key: pick(floors, r.kind === 'kitchen' ? /tile|stone|terrazzo/i : /oak|wood|parquet/i) } });
      await m.api(`${base}/finishes`, { method: 'PUT', body: { room_id: r.id, surface: 'wall', finish_key: pick(walls, /lime|paint|plaster/i) } });
    }
    await m.api(`${base}/renders`, { method: 'POST', body: { view: { style: 'scandinavian', angle: 'corner-ne' } } });
    await m.api(`${base}/estimates/items`, { method: 'POST', body: { label: 'Linen curtains', qty: 2, unit: 'pcs', unit_low: 60, unit_high: 140 } });
    await m.api(`${base}/comments`, { method: 'POST', body: { body: 'Can the sofa face the window instead?', plan_version_no: 2 } });
    await m.api(`${base}/decisions`, { method: 'POST', body: { plan_version_no: 2, decision: 'concept_approved', note: 'The warm Japandi palette works — approved for the dossier.' } });
    await m.api(`${base}/tasks`, { method: 'POST', body: { title: 'Order linen and oak samples', status: 'doing' } });
    await m.api(`${base}/tasks`, { method: 'POST', body: { title: 'Confirm the reading-corner lamp' } });
    await m.api(`${base}/messages`, { method: 'POST', body: { body: 'Samples arrive on Tuesday — I will bring them to the meeting.' } });
    await new Promise((r) => setTimeout(r, 4000));
    await m.api(`${base}/dossiers`, { method: 'POST', body: { plan_version_no: 2, note: 'First concept for review' } });
    await m.api('/projects', { method: 'POST', body: { name: 'Hillside Studio Loft' } });
  }, pid);

  // ---- stills at 1490x812 ----
  const s = await (await b.newContext({ viewport: { width: 1490, height: 812 } })).newPage();
  s.on('pageerror', (e) => errs.push(String(e)));
  await login(s);
  const shot = async (name, hash, prep) => { await s.goto('about:blank'); await s.goto(U + '/' + hash); await pause(s, 2500); if (prep) await prep(); await pause(s, 600);
    await s.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 82 }); };
  await shot('dashboard', '#/dashboard');
  await shot('plan-editor', `#/p/${pid}/plan`, async () => { const jump = s.locator('.panel-sel select'); const val = await jump.evaluate((el) => [...el.options].map((o) => o.value).find((v) => v.startsWith('furniture:'))); if (val) await jump.selectOption(val); });
  await shot('studio', `#/p/${pid}/renders`);
  await shot('brief', `#/p/${pid}/brief`);
  await shot('dossier', `#/p/${pid}/dossier`, async () => { await s.evaluate(() => scrollTo(0, 0)); });
  await shot('budget', `#/p/${pid}/budget`, async () => { await s.evaluate(() => document.getElementById('handover-budget').scrollIntoView({ block: 'start' })); await s.evaluate(() => scrollBy(0, -80)); });
  await shot('review', `#/p/${pid}/collab`);
  await shot('branding', '#/branding');
  console.log('errors', JSON.stringify(errs));
  await b.close();
})();
