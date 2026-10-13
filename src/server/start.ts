/**
 * Start na hostingu (Railway): migracje → pierwszy właściciel (opcjonalnie) → serwer. Jeden proces, zero ręcznych kroków.
 *
 * Wymagane: DATABASE_URL — adres bazy z uprawnieniami właściciela (na Railway: ${{Postgres.DATABASE_URL}}).
 * Serwer NIE obsługuje żądań tym połączeniem: tworzy osobną rolę `openauto_app` bez prawa omijania RLS
 * i łączy się nią. Hasło tej roli jest wyprowadzane z OPENAUTO_MASTER_KEY (stałe między wdrożeniami),
 * więc nie trzeba nim zarządzać ręcznie.
 *
 * Wariant z osobnymi adresami (docker-compose): MIGRATION_DATABASE_URL = właściciel, DATABASE_URL = openauto_app.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { createPool } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { bootstrapFromEnv } from './db/bootstrap.ts';
import { masterKeyStatus } from './crypto/secrets.ts';
import { runServer } from './server.ts';

const APP_ROLE = process.env.APP_DB_USER ?? 'openauto_app';

function withCredentials(url: string, user: string, password: string) {
  const u = new URL(url);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  return u.toString();
}

function appRolePassword(): string {
  const raw = process.env.OPENAUTO_MASTER_KEY;
  if (masterKeyStatus(raw) === 'ok') {
    return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(raw!), Buffer.from('openauto-crm'), Buffer.from('db-app-role'), 32)).toString(
      'base64url',
    );
  }
  console.warn('UWAGA: brak OPENAUTO_MASTER_KEY — losowe hasło roli bazy przy każdym starcie; kopie zapasowe wyłączone.');
  return crypto.randomBytes(32).toString('base64url');
}

async function main() {
  const separate = !!process.env.MIGRATION_DATABASE_URL && !!process.env.DATABASE_URL &&
    process.env.MIGRATION_DATABASE_URL !== process.env.DATABASE_URL;
  const adminUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!adminUrl) throw new Error('Brak DATABASE_URL — dodaj w Railway zmienną DATABASE_URL = ${{Postgres.DATABASE_URL}}');
  const password = separate ? process.env.APP_DB_PASSWORD : appRolePassword();
  const driver = process.env.DB_DRIVER ?? 'pg';

  const admin = await createPool(adminUrl, driver, 2);
  try {
    const applied = await migrate(admin, {
      migrationsDir: path.resolve(process.env.MIGRATIONS_DIR ?? 'db/migrations'),
      appRole: APP_ROLE,
      appRolePassword: password,
      log: (m) => console.log(m),
    });
    console.log(applied.length ? `Zastosowano migracje: ${applied.join(', ')}` : 'Baza jest aktualna');
    await bootstrapFromEnv(admin);
  } finally {
    await admin.end();
  }

  const appUrl = separate ? process.env.DATABASE_URL! : withCredentials(adminUrl, APP_ROLE, password!);
  await runServer({ cfg: loadConfig(appUrl), adminUrl });
}

main().catch((e) => {
  console.error('Start nieudany:', e?.message ?? e);
  process.exit(1);
});
