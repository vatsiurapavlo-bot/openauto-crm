/** npm run migrate — stosuje migracje i nadaje uprawnienia roli aplikacji. */
import path from 'node:path';
import { createPool } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('Ustaw MIGRATION_DATABASE_URL (rola właściciela schematu), zobacz .env.example');
  process.exit(1);
}

const pool = await createPool(url, process.env.DB_DRIVER ?? 'pg', 1);
try {
  const applied = await migrate(pool, {
    migrationsDir: path.resolve(process.env.MIGRATIONS_DIR ?? 'db/migrations'),
    appRole: process.env.APP_DB_USER ?? 'openauto_app',
    appRolePassword: process.env.APP_DB_PASSWORD,
    log: (m) => console.log(m),
  });
  console.log(applied.length ? `Zastosowano migracje: ${applied.length}` : 'Baza jest aktualna');
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
