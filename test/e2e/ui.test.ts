/**
 * Test interfejsu w prawdziwej przeglądarce (Playwright/Chromium) na zbudowanej aplikacji.
 * Wymaga: npm run build, przeglądarki Playwright (npx playwright install chromium).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { createTestDatabase, seedWorkspace, statusId, type Seeded, type TestDb } from '../helpers/db.ts';
import { startServer } from '../helpers/server.ts';

let t: TestDb;
let A: Seeded;
let srv: Awaited<ReturnType<typeof startServer>>;
let browser: Browser;

before(async () => {
  assert.ok(fs.existsSync('dist/public/index.html'), 'Najpierw uruchom: npm run build');
  t = await createTestDatabase();
  A = await seedWorkspace(t.owner);
  srv = await startServer(t.app, 'dist/public');
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await srv?.close();
  await t?.drop();
});

async function login(page: Page, role: string) {
  await page.goto(srv.base + '/');
  await page.fill('input[type=email]', A.users[role].email);
  await page.fill('input[type=password]', A.users[role].password);
  await page.click('button:has-text("Zaloguj")');
  await page.waitForSelector('.sidebar');
}

test('Właściciel: dodaje auto, zmienia status, rozlicza — auto przechodzi do Rozliczone', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'pl-PL' });
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await login(page, 'owner');
  await page.waitForSelector('.tiles');

  await page.click('a.nav-item:has-text("Samochody")');
  await page.click('button:has-text("Dodaj samochód")');
  const modal = page.locator('.modal');
  await modal.locator('label:has-text("Marka") input').fill('Volkswagen');
  await modal.locator('label:has-text("Model") input').fill('Tiguan');
  await modal.locator('label:has-text("Rok produkcji") input').fill('2011');
  await modal.locator('label:has-text("VIN") input').fill('wvgzzz5nzbw000001');
  await modal.locator('label:has-text("Cena A") input').fill('42 900');
  await modal.locator('label:has-text("Wartość auta") input').fill('31500');
  await modal.locator('button:has-text("Dodaj samochód")').click();

  await page.waitForSelector('.detail-head');
  assert.equal(await page.locator('.detail-head .car-no').textContent(), '#1');
  assert.match((await page.locator('.detail-head h1').textContent())!, /Volkswagen Tiguan/);
  assert.match((await page.locator('.panel-fin').textContent())!, /11\s400,00\szł/); // Zysk A

  const naPlacu = await statusId(t.owner, A.workspaceId, 'logistic', 'na_placu');
  await page.selectOption('select[aria-label="Status logistyczny"]', naPlacu);
  await page.waitForSelector('.timeline li:has-text("W drodze → Na placu")');

  page.once('dialog', (d) => void d.accept());
  const rozl = await statusId(t.owner, A.workspaceId, 'settlement', 'rozliczone');
  await page.selectOption('select[aria-label="Status rozliczenia"]', rozl);
  await page.waitForSelector('.detail-head .badge:has-text("Rozliczone")');

  await page.click('a.nav-item:has-text("Samochody")');
  await page.waitForSelector('.empty');
  await page.click('a.nav-item:has-text("Rozliczone")');
  await page.waitForSelector('.table tr.clickable');
  assert.equal(await page.locator('.table tr.clickable').count(), 1);

  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/e2e-rozliczone.png`, fullPage: true });
  assert.deepEqual(pageErrors, []);
  await ctx.close();
});

test('Serwis: widzi tylko swoje menu i auta w Serwisie, bez finansów', async () => {
  const serwis = await statusId(t.owner, A.workspaceId, 'logistic', 'serwis');
  const ws = A.workspaceId;
  await t.owner.query(
    `INSERT INTO cars (workspace_id, marka, model, logistic_status_id, sales_status_id, settlement_status_id)
     SELECT $1, 'Toyota', 'Corolla', $2, (SELECT id FROM car_statuses WHERE workspace_id=$1 AND kind='sales' AND is_default),
            (SELECT id FROM car_statuses WHERE workspace_id=$1 AND kind='settlement' AND is_default)`,
    [ws, serwis],
  );
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await login(page, 'serwis');
  await page.waitForURL(/\/serwis$/);
  const menu = await page.locator('.nav').textContent();
  assert.ok(!menu!.includes('Kasa') && !menu!.includes('Dashboard') && !menu!.includes('Użytkownicy'));
  await page.waitForSelector('.car-card');
  assert.equal(await page.locator('.car-card').count(), 1);
  assert.equal(await page.locator('.car-card-fin').count(), 0);
  await page.click('.car-card');
  await page.waitForSelector('.detail-head');
  assert.equal(await page.locator('.panel-fin').count(), 0);
  assert.equal(await page.locator('button:has-text("Edytuj")').count(), 0);
  assert.ok(await page.locator('select[aria-label="Status rozliczenia"]').isDisabled());
  await ctx.close();
});

test('Telefon: menu wysuwane, karty w jednej kolumnie', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await login(page, 'manager');
  await page.waitForSelector('.topbar');
  assert.ok(!(await page.locator('.sidebar').isVisible()) || (await page.locator('.sidebar').boundingBox())!.x < 0);
  await page.click('button[aria-label="Otwórz menu"]');
  await page.click('a.nav-item:has-text("Rozliczone")');
  await page.waitForURL(/\/rozliczone$/);
  assert.equal(await page.locator('.topbar-title').textContent(), 'Rozliczone');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, 'brak poziomego przewijania na telefonie');
  await ctx.close();
});

test('Koszty i Kasa: koszt gotówką z karty auta → kasa zmniejsza się; anulowanie oddaje gotówkę', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'pl-PL' });
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await login(page, 'manager');
  // auto do testu
  await page.click('a.nav-item:has-text("Samochody")');
  await page.click('button:has-text("Dodaj samochód")');
  const carModal = page.locator('.modal');
  await carModal.locator('label:has-text("Marka") input').fill('Peugeot');
  await carModal.locator('label:has-text("Model") input').fill('3008');
  await carModal.locator('button:has-text("Dodaj samochód")').click();
  await page.waitForSelector('.detail-head');

  const kasaBefore = async () => {
    const r = await page.evaluate(() => fetch('/api/kasa', { headers: { Accept: 'application/json' } }).then((x) => x.json()));
    return Number(r.aktualna);
  };
  const before = await kasaBefore();

  // koszt z karty auta
  await page.click('.panel:has-text("Koszty auta") button:has-text("Dodaj koszt")');
  const m = page.locator('.modal');
  await m.locator('input[aria-label="Kwota"]').fill('1 500');
  await m.locator('label:has-text("Opis") input').fill('Transport z Belgii');
  await m.locator('label:has-text("Kategoria") select').selectOption({ label: 'Transport' });
  assert.match(await m.locator('.field-hint').first().textContent() ?? '', /kasa zmniejszy się automatycznie o 1\s500,00\szł/);
  await m.locator('button:has-text("Dodaj koszt")').click();
  await page.waitForSelector('.panel:has-text("Koszty auta") td:has-text("Transport z Belgii")');
  assert.equal(await kasaBefore(), before - 1500);
  // koszty widoczne w finansach auta
  await page.waitForFunction(() => (document.querySelector('.panel-fin')?.textContent ?? '').replace(/\s/g, ' ').includes('1 500,00'));

  // Kasa: wydatek z numerem kosztu i autem
  await page.click('a.nav-item:has-text("Kasa")');
  await page.waitForSelector('.desktop-only td:has-text("Transport z Belgii")');
  const row = page.locator('.desktop-only tr', { hasText: 'Transport z Belgii' });
  assert.match((await row.textContent()) ?? '', /Wydatek.*−1\s500,00\szł/);

  // anulowanie w Kosztach
  await page.click('a.nav-item:has-text("Koszty")');
  await page.click('.desktop-only td:has-text("Transport z Belgii")');
  await page.click('.modal button:has-text("Anuluj koszt")');
  await page.click('.modal button:has-text("Tak, anuluj koszt")');
  await page.waitForSelector('.modal', { state: 'detached' });
  assert.equal(await kasaBefore(), before);
  assert.deepEqual(pageErrors, []);
  await ctx.close();
});

test('Telefon: Koszty i Kasa bez poziomego przewijania', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await login(page, 'owner');
  for (const path of ['/koszty', '/kasa']) {
    await page.goto(srv.base + path);
    await page.waitForSelector('.money-row');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, path);
  }
  await ctx.close();
});
