/**
 * Odtworzenie bazy z zaszyfrowanej kopii (.oabak) — procedura awaryjna, zwykle z pomocą Claude.
 *
 *   OPENAUTO_MASTER_KEY=... DATABASE_URL=<adres bazy docelowej, rola właściciela> \
 *     node dist/server/restore.js kopia.oabak
 *
 *   node dist/server/restore.js kopia.oabak --decrypt-only kopia.dump   (tylko odszyfrowanie)
 *
 * UWAGA: odtworzenie ZASTĘPUJE dane w bazie docelowej.
 */
import fs from 'node:fs';
import path from 'node:path';
import { decrypt } from '../crypto/secrets.ts';
import { restoreFromSealed } from '../services/backup.ts';
import { createPool } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';

const [file, flag, out] = process.argv.slice(2);
if (!file || !fs.existsSync(file)) {
  console.error('Użycie: node dist/server/restore.js <plik.oabak> [--decrypt-only <plik.dump>]');
  process.exit(1);
}
const sealed = fs.readFileSync(file);

if (flag === '--decrypt-only') {
  if (!out) throw new Error('Podaj plik wynikowy');
  fs.writeFileSync(out, decrypt(sealed, 'backup'), { mode: 0o600 });
  console.log(`Odszyfrowano do ${out} (format pg_dump custom — pg_restore)`);
} else {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Ustaw DATABASE_URL (baza docelowa, rola właściciela)');
  console.log(`Odtwarzanie ${path.basename(file)}…`);
  await restoreFromSealed(sealed, url);
  const pool = await createPool(url, process.env.DB_DRIVER ?? 'pg', 1);
  try {
    await migrate(pool, { migrationsDir: path.resolve(process.env.MIGRATIONS_DIR ?? 'db/migrations'), log: console.log });
  } finally {
    await pool.end();
  }
  console.log('Gotowe. Uruchom ponownie aplikację (Redeploy w Railway), aby nadać uprawnienia roli aplikacji.');
}
