#!/usr/bin/env node
/**
 * Browser acceptance run against the production build (API serving the built SPA) and a throwaway DB.
 * Synthetic user only. Usage: pnpm build && TEST_MONGO_URI=mongodb://127.0.0.1:27118 pnpm e2e
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url).pathname;
const api = root + 'apps/api';
const PORT = 4300 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
const DB = `workout_e2e_${Date.now()}`;
const MONGO = process.env.TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27118';
const env = { ...process.env, MONGO_URI: `${MONGO}/${DB}`, PORT: String(PORT), APP_ORIGIN: BASE, COOKIE_SECURE: 'false' };
const USER = 'e2e-user', PASS = 'synthetic password 123';
const cli = (args, input = '') => { const r = spawnSync('node', ['dist/cli.js', ...args], { cwd: api, env, input, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };

cli(['import-pack', '../../data/training-pack.v1.json']);
cli(['bootstrap-user'], `BOOTSTRAP_USERNAME=${USER}\nBOOTSTRAP_PASSWORD=${PASS}\n`);
const server = spawn('node', ['dist/main.js'], { cwd: api, env, stdio: 'inherit' });
for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/v1/health/ready')).ok) break; } catch { /* booting */ } await new Promise((r) => setTimeout(r, 100)); }

const browser = await chromium.launch();
const results = [];
const step = async (name, fn) => { try { await fn(); results.push(`PASS ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message.split('\n')[0]}`); throw e; } };
const noOverflow = async (page, where) => {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.ok(sw <= cw, `horizontal overflow on ${where}: ${sw} > ${cw}`);
};
const smallTargets = (page) => page.evaluate(() => [...document.querySelectorAll('button, .btn, .nav a, input:not([type=checkbox]):not([type=radio]):not([hidden]), select')]
  .filter((el) => el.offsetParent !== null).filter((el) => el.getBoundingClientRect().height < 43.5).map((el) => el.outerHTML.slice(0, 80)));

try {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/youtube|ERR_FAILED|401|409/i.test(m.text())) consoleErrors.push(m.text()); });

  await step('login rejects a wrong password generically, accepts the right one', async () => {
    await page.goto(BASE);
    await page.getByLabel('Username').fill(USER);
    await page.getByLabel('Password', { exact: true }).fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByText('Incorrect username or password').waitFor();
    await page.getByLabel('Password', { exact: true }).fill(PASS);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Today' }).waitFor();
    await noOverflow(page, 'today');
  });

  await step('program start date is chosen in Settings, then Today offers week 1 restart A', async () => {
    await page.getByRole('link', { name: 'Settings' }).click();
    const monday = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); });
    await page.getByLabel('Start date').fill(monday);
    await page.getByRole('button', { name: 'Save program' }).click();
    await page.getByText('Saved').first().waitFor();
    await noOverflow(page, 'settings');
    await page.getByRole('link', { name: 'Today' }).click();
    await page.getByText('week 1').waitFor();
    await page.getByText('Relearn the movements').waitFor();
    await page.getByRole('button', { name: /^Start Restart A/ }).click();
    await page.getByRole('heading', { name: /Restart A/ }).waitFor();
    await page.getByText(/Week 1 · Relearn the movements/).waitFor({ timeout: 5000 }).catch(async (e) => { console.log(await page.evaluate(() => fetch('/api/v1/sessions/active').then((r) => r.json()).then((j) => JSON.stringify(j.session?.programContext)))); console.log((await page.locator('main').innerText()).slice(0, 600)); throw e; });
    await noOverflow(page, 'workout');
    const small = await smallTargets(page);
    assert.deepEqual(small, [], 'tap targets under 44px');
  });

  await step('log sets: goblet squat single-dumbbell, row left/right independent, rest timer after both sides', async () => {
    const goblet = page.locator('section.exercise', { hasText: 'Goblet squat' });
    await goblet.getByLabel('Set 1 reps').fill('12');
    await goblet.getByLabel(/Set 1 kg \(one dumbbell\)/).fill('10');
    await goblet.getByRole('button', { name: 'Done' }).click();
    await goblet.getByRole('button', { name: '✓ Done' }).waitFor();
    await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
    await page.getByText(/^Rest \d/).waitFor();
    await page.getByRole('button', { name: 'Skip rest' }).click();
    const row = page.locator('section.exercise', { hasText: 'row' }).first();
    await row.getByLabel('Set 1 L reps').fill('12');
    await row.getByLabel('Set 1 L kg per dumbbell').fill('10,5');
    await row.locator('.set', { hasText: 'Set 1 L' }).getByRole('button', { name: 'Done' }).click();
    await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
    assert.equal(await page.getByText(/^Rest \d/).count(), 0, 'rest started before right side');
    assert.equal(await row.getByLabel('Set 1 R reps').inputValue(), '', 'right side was auto-filled');
    await row.getByLabel('Set 1 R reps').fill('10');
    await row.getByLabel('Set 1 R kg per dumbbell').fill('10.5');
    await row.locator('.set', { hasText: 'Set 1 R' }).getByRole('button', { name: 'Done' }).click();
    await page.getByText(/^Rest \d/).waitFor();
  });

  await step('refresh keeps acknowledged sets', async () => {
    await page.reload();
    const row = page.locator('section.exercise', { hasText: 'row' }).first();
    await row.getByLabel('Set 1 R reps').waitFor();
    assert.equal(await row.getByLabel('Set 1 R reps').inputValue(), '10');
    assert.equal(await row.getByLabel('Set 1 L kg per dumbbell').inputValue(), '10.5');
  });

  await step('API unreachable: set waits in the outbox across a refresh, then replays exactly once', async () => {
    await page.route('**/api/v1/sessions/**', (r) => (r.request().method() === 'PATCH' ? r.abort() : r.continue()));
    const bench = page.locator('section.exercise', { hasText: 'Dumbbell bench press' });
    await bench.getByLabel('Set 1 reps').fill('9');
    await bench.getByLabel('Set 1 kg per dumbbell').fill('12');
    await bench.getByRole('button', { name: 'Done' }).click();
    await page.getByText(/Offline - pending sync \(1\)/).waitFor();
    await page.reload();
    await page.getByText(/Offline - pending sync \(1\)/).waitFor();
    assert.equal(await bench.getByLabel('Set 1 reps').inputValue(), '9', 'pending value not shown after refresh');
    await page.unroute('**/api/v1/sessions/**');
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor({ timeout: 10_000 });
    const id = page.url().split('/').pop();
    const s = await page.evaluate((sid) => fetch(`/api/v1/sessions/${sid}`).then((r) => r.json()), id);
    const sets = s.exercises.find((o) => o.exerciseId === 'db-bench-press').sets;
    assert.equal(sets.filter((x) => x.status === 'done').length, 1);
    assert.equal(sets[0].actualLoad.valueGrams, 12000);
    assert.equal(sets[0].actualLoad.implementCount, 2);
  });

  await step('a second tab editing a stale revision gets "Conflict - review"', async () => {
    const other = await ctx.newPage();
    await other.goto(page.url());
    const bridgeA = page.locator('section.exercise', { hasText: 'Glute bridge' });
    await bridgeA.getByLabel('Set 1 reps').fill('15');
    await bridgeA.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
    // `other` still holds the old revision in memory; its next write must not silently win.
    await other.evaluate(() => localStorage.clear());
    const bridgeB = other.locator('section.exercise', { hasText: 'Glute bridge' });
    await bridgeB.getByLabel('Set 1 reps').fill('11');
    await bridgeB.getByRole('button', { name: 'Done' }).click();
    await other.getByRole('heading', { name: 'Conflict - review' }).waitFor();
    await other.getByRole('button', { name: 'Keep server version' }).click();
    await other.close();
    await page.reload();
    assert.equal(await page.locator('section.exercise', { hasText: 'Glute bridge' }).getByLabel('Set 1 reps').inputValue(), '15');
  });

  await step('pause and resume', async () => {
    await page.getByRole('button', { name: 'Pause' }).click();
    await page.getByText('Paused. Your sets are saved').waitFor();
    await page.getByRole('button', { name: 'Resume' }).click();
    await page.getByRole('button', { name: 'Pause' }).waitFor();
  });

  await step('video loads only on click via youtube-nocookie, with a direct link', async () => {
    const goblet = page.locator('section.exercise', { hasText: 'Goblet squat' });
    await goblet.getByText('Cues and video').click();
    assert.equal(await page.locator('iframe').count(), 0);
    await goblet.getByRole('button', { name: /Load video/ }).click();
    const src = await goblet.locator('iframe').getAttribute('src');
    assert.match(src, /^https:\/\/www\.youtube-nocookie\.com\/embed\/9KzZD_n2r64/);
    assert.ok(!/autoplay=1/.test(src));
    assert.equal(await goblet.getByRole('link', { name: 'Open on YouTube' }).getAttribute('href'), 'https://www.youtube.com/watch?v=9KzZD_n2r64');
  });

  await step('partial finish keeps missing work and lands in history', async () => {
    await page.getByRole('button', { name: 'Finish…' }).click();
    await page.getByText(/required working sets done — will be saved as partial/).waitFor();
    await page.getByRole('button', { name: 'Finish', exact: true }).click();
    await page.getByText('partial').first().waitFor();
    await page.getByRole('cell', { name: '✓ done' }).first().waitFor();
    await page.getByRole('cell', { name: 'pending' }).first().waitFor();
    await noOverflow(page, 'history detail');
    await page.getByRole('link', { name: 'History', exact: true }).click();
    await page.getByText('Restart A - squat, push and pull').waitFor();
    await noOverflow(page, 'history');
  });

  await step('weigh-in with a decimal comma is stored as grams', async () => {
    await page.getByRole('link', { name: 'Weight' }).click();
    await page.getByLabel('Weight (kg)').fill('80,5');
    await page.getByRole('button', { name: 'Save weigh-in' }).click();
    await page.getByText('80.5 kg').waitFor();
    await noOverflow(page, 'weight');
  });

  await step('importing the real v2 pack replaces the catalog with four three-section plans', async () => {
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByLabel('Or paste JSON').fill(readFileSync(root + 'data/training-pack.v2.json', 'utf8'));
    await page.getByRole('button', { name: 'Preview' }).click();
    await page.getByText('plans: 4 new, 0 unchanged, 0 conflicting').waitFor();
    await page.getByText('exercises: 29 new, 21 unchanged, 0 conflicting').waitFor();
    await page.getByRole('button', { name: 'Import and activate' }).click();
    await page.getByText(/imported and activated/).waitFor();
    await page.getByRole('link', { name: 'Plans' }).click();
    await page.locator('ul.cards > li h2', { hasText: 'D - Abs and core' }).waitFor({ timeout: 5000 }).catch(async (e) => { console.log(page.url(), (await page.locator('main').innerText()).slice(0, 800)); throw e; });
    assert.deepEqual(await page.locator('ul.cards > li h2').allInnerTexts(), ['A - Arms, shoulders and back', 'B - Chest, shoulders and back', 'C - Legs and glutes', 'D - Abs and core']);
    await page.getByText('Warm-up 7 · Workout 7 · Cooldown 4').waitFor();
    await noOverflow(page, 'plans v2');
    await page.getByRole('link', { name: 'Today' }).click();
    await page.getByText('Four fixed dumbbell sessions').waitFor();
    assert.equal(await page.getByText(/week \d/).count(), 0, 'week/phase shown for a fixed program');
  });

  await step('plan detail shows Warm-up, Workout and Cooldown with per-exercise cards', async () => {
    await page.getByRole('link', { name: 'Plans' }).click();
    await page.getByText('A - Arms, shoulders and back').click();
    for (const h of [/^Warm-up ·/, /^Workout$/, /^Cooldown ·/]) await page.getByRole('heading', { name: h }).waitFor();
    await page.getByText('Light rehearsal - not a work set.').first().waitFor();
    await noOverflow(page, 'plan detail v2');
  });

  await step('three-section workout: acknowledge, skip, both sides, log, continue to cooldown, finish', async () => {
    await page.getByRole('button', { name: 'Start now' }).click();
    const nav = page.getByRole('navigation', { name: 'Workout sections' });
    await nav.waitFor();
    await nav.getByRole('button', { name: /Warm-up 0\/7/ }).waitFor();
    assert.deepEqual(await smallTargets(page), [], 'tap targets under 44px (warm-up)');
    await noOverflow(page, 'warm-up');
    const march = page.locator('section.activity', { hasText: 'March on the spot' });
    await march.getByRole('button', { name: 'Done', exact: true }).click();
    await march.locator('.done-text', { hasText: '✓ Done' }).waitFor();
    await nav.getByRole('button', { name: /Warm-up 1\/7/ }).waitFor();
    const circles = page.locator('section.activity').nth(1);
    await circles.getByRole('button', { name: 'Skip', exact: true }).click();
    await circles.locator('.tag', { hasText: 'skipped' }).waitFor();
    const rowRehearsal = page.locator('section.activity', { hasText: 'Light rehearsal' }).first();
    await rowRehearsal.getByRole('button', { name: 'Mark both sides done' }).click();
    await rowRehearsal.getByText('✓ done', { exact: true }).waitFor();
    await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
    await page.getByRole('button', { name: 'Continue to workout →' }).click();
    const row = page.locator('section.exercise', { hasText: 'row' }).first();
    await row.getByLabel('Set 1 L reps').fill('12');
    await row.getByLabel('Set 1 L kg per dumbbell').fill('8');
    await row.locator('.set', { hasText: 'Set 1 L' }).getByRole('button', { name: 'Done' }).click();
    await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
    const french = page.locator('section.exercise', { hasText: 'French' });
    await french.getByText('kg (one dumbbell)').waitFor();
    await noOverflow(page, 'workout v2');
    await page.getByRole('button', { name: 'Continue to cooldown →' }).click();
    const stretch = page.locator('section.activity', { hasText: 'shoulder stretch' }).first();
    await stretch.getByRole('button', { name: 'Log actual' }).first().click();
    await stretch.getByLabel(/Left seconds/).fill('25');
    await stretch.getByRole('button', { name: 'Save' }).click();
    await stretch.getByText('✓ 25 s').waitFor();
    await page.reload();
    await page.getByRole('navigation', { name: 'Workout sections' }).getByRole('button', { name: /Cooldown/ }).waitFor();
    await page.locator('section.activity', { hasText: 'shoulder stretch' }).first().getByText('✓ 25 s').waitFor();
    await noOverflow(page, 'cooldown');
    await page.getByRole('button', { name: 'Finish workout' }).click();
    await page.getByText(/Warm-up: 2\/7 done, 1 skipped · Cooldown: 0\/4 done/).waitFor();
    await page.getByRole('button', { name: 'Finish', exact: true }).click();
    await page.getByRole('heading', { name: 'Warm-up' }).waitFor();
    await page.getByText('done (no numbers recorded)').first().waitFor();
    await page.getByText('left done: 25 s').waitFor();
    await noOverflow(page, 'history v2');
  });

  await step('an old-format workout still shows its own history without invented cooldown records', async () => {
    await page.getByRole('link', { name: 'History', exact: true }).click();
    await page.getByText('Restart A - squat, push and pull').first().click();
    await page.getByText('Not recorded in this workout format.').waitFor();
    await page.getByText(/Warm-up checklist: \d+\/\d+ ticked/).waitFor();
  });

  await step('logout clears local state; private API then refuses', async () => {
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Log out' }).click();
    await page.getByRole('button', { name: 'Sign in' }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    assert.equal(await page.evaluate(() => fetch('/api/v1/today').then((r) => r.status)), 401);
  });

  await step('desktop layout renders without overflow', async () => {
    const d = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await d.goto(BASE);
    await d.getByLabel('Username').fill(USER);
    await d.getByLabel('Password', { exact: true }).fill(PASS);
    await d.keyboard.press('Enter');
    await d.getByRole('heading', { name: 'Today' }).waitFor();
    await noOverflow(d, 'desktop today');
    await d.goto(BASE + '/plans/chest');
    await d.getByRole('heading', { name: /Chest/ }).waitFor();
    await noOverflow(d, 'desktop plan');
  });

  assert.deepEqual(consoleErrors, [], 'console errors');
} finally {
  console.log(results.join('\n'));
  await browser.close();
  server.kill('SIGTERM');
  const m = await MongoClient.connect(MONGO);
  await m.db(DB).dropDatabase();
  await m.close();
}
