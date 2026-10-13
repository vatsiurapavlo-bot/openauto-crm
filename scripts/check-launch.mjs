/**
 * Перевірка захисту живої адреси CRM перед внесенням реальних даних.
 *
 *   node scripts/check-launch.mjs https://openauto-crm.up.railway.app
 *   CHECK_EMAIL=... CHECK_PASSWORD=... node scripts/check-launch.mjs <адреса>   (повна перевірка з входом)
 *
 * Скрипт нічого не змінює в CRM (лише читає), окрім одного входу/виходу тестовим акаунтом.
 */
const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('Вкажіть адресу: node scripts/check-launch.mjs https://...');
  process.exit(2);
}

const results = [];
const check = (ok, name, detail = '') => results.push({ ok, name, detail });
const H = { 'X-Requested-With': 'openauto', 'Content-Type': 'application/json' };

async function main() {
  check(base.startsWith('https://'), 'Адреса використовує HTTPS', base);

  if (base.startsWith('https://')) {
    try {
      const r = await fetch(base.replace('https://', 'http://') + '/', { redirect: 'manual' });
      const loc = r.headers.get('location') ?? '';
      check(r.status >= 300 && r.status < 400 && loc.startsWith('https://'), 'HTTP перенаправляє на HTTPS', `${r.status} → ${loc || '—'}`);
    } catch (e) {
      check(true, 'HTTP недоступний (лише HTTPS)', String(e.message ?? e));
    }
  }

  const health = await fetch(base + '/api/health');
  check(health.ok, 'Сервер і база даних працюють (/api/health)', String(health.status));

  const home = await fetch(base + '/');
  const h = home.headers;
  check(!!h.get('content-security-policy')?.includes("frame-ancestors 'none'"), 'Заголовок Content-Security-Policy');
  check(h.get('x-frame-options') === 'DENY', 'Захист від вбудовування в чужі сайти (X-Frame-Options)');
  check(h.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff');
  check(!!h.get('strict-transport-security'), 'HSTS (браузер завжди використовує HTTPS)');
  check(!/x-powered-by/i.test([...h.keys()].join(',')), 'Сервер не розкриває свою технологію');

  const html = await home.text();
  const js = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  if (js) {
    const map = await fetch(base + js + '.map');
    check(map.status === 404, 'Вихідний код інтерфейсу не викладений (без source map)');
  }

  const anon = await fetch(base + '/api/cars');
  check(anon.status === 401, 'Дані недоступні без входу', `/api/cars → ${anon.status}`);

  const csrf = await fetch(base + '/api/auth/logout', { method: 'POST' });
  check(csrf.status === 403, 'Захист від CSRF (запити з інших сайтів відхиляються)', String(csrf.status));

  const bad = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ email: 'nie-istnieje@example.com', password: 'zle-haslo-123' }),
  });
  const badBody = await bad.text();
  check(bad.status === 401 && !/stack|sql|postgres/i.test(badBody), 'Невдалий вхід не розкриває деталей', String(bad.status));

  const email = process.env.CHECK_EMAIL;
  const password = process.env.CHECK_PASSWORD;
  if (email && password) {
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email, password }) });
    const cookie = login.headers.get('set-cookie') ?? '';
    check(login.ok, 'Вхід власника працює', String(login.status));
    check(/;\s*Secure/i.test(cookie), 'Cookie сесії лише через HTTPS (Secure)');
    check(/;\s*HttpOnly/i.test(cookie), 'Cookie сесії недоступна для скриптів (HttpOnly)');
    check(/;\s*SameSite=Lax/i.test(cookie), 'Cookie сесії SameSite=Lax');
    const c = { Cookie: cookie.split(';')[0] };
    const me = await (await fetch(base + '/api/auth/me', { headers: c })).json();
    check(me.role === 'owner' || me.role === 'administrator', 'Акаунт має права власника/адміністратора', me.role);
    const b = await fetch(base + '/api/system/backup', { headers: c });
    if (b.ok) {
      const s = await b.json();
      check(s.masterKey === 'ok', 'Ключ шифрування OPENAUTO_MASTER_KEY встановлено');
      check(!!s.drive, 'Google Drive підключено', s.drive?.accountEmail ?? '');
      check(s.pgDump?.compatible === true, 'Інструмент резервних копій сумісний з базою', s.pgDump?.message ?? s.pgDump?.version ?? '');
      check(s.scheduleEnabled === true, 'Автоматичні щоденні копії увімкнені');
      const age = s.lastOk ? (Date.now() - Date.parse(s.lastOk)) / 3.6e6 : Infinity;
      check(age < 26, 'Остання успішна копія молодша за 26 год', s.lastOk ?? 'ще не було');
    } else check(false, 'Стан резервних копій', String(b.status));
    results.push({ ok: null, name: `Режим CRM: ${me.mode}`, detail: me.mode === 'production' ? 'реальні дані дозволені' : 'після цієї перевірки власник вирішує, чи змінити на production' });
    await fetch(base + '/api/auth/logout', { method: 'POST', headers: { ...H, ...c } });
  } else {
    results.push({ ok: null, name: 'Перевірка входу, cookie та копій пропущена', detail: 'задайте CHECK_EMAIL і CHECK_PASSWORD' });
  }

  for (const r of results) console.log(`${r.ok === null ? '–' : r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  const failed = results.filter((r) => r.ok === false).length;
  console.log(failed ? `\nПроблем: ${failed}. Не вносьте реальні дані, доки їх не усунуто.` : '\nУсі перевірки пройдено.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('Перевірка не вдалася:', e.message ?? e);
  process.exit(1);
});
