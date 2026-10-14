import http from 'node:http';
import type { Config } from './config.ts';
import { Database, createPool, type PoolLike } from './db/index.ts';
import { checkAppRoleIsRestricted } from './db/migrate.ts';
import { createApp } from './app.ts';
import { BackupService } from './services/backup.ts';
import { googleConfig } from './integrations/google/drive.ts';

export interface RunOptions {
  cfg: Config;
  /** Połączenie administracyjne (właściciel schematu) — tylko kopie zapasowe i token Dysku */
  adminUrl?: string | null;
}

export async function runServer({ cfg, adminUrl }: RunOptions) {
  const pool = await createPool(cfg.databaseUrl, cfg.dbDriver);
  const db = new Database(pool);

  const problem = await checkAppRoleIsRestricted(pool);
  if (problem) {
    const msg = `UWAGA: ${problem}. Uprawnienia w bazie (RLS) nie będą egzekwowane.`;
    if ((cfg.isProduction || cfg.environmentName) && !cfg.allowInsecureDbRole) {
      console.error(msg + ' Uruchom aplikację rolą openauto_app (zobacz README). Zatrzymuję.');
      process.exit(1);
    }
    console.warn(msg);
  }

  let adminPool: PoolLike | null = null;
  let backup: BackupService | null = null;
  const google = googleConfig(cfg.publicUrl);
  if (adminUrl) {
    adminPool = await createPool(adminUrl, cfg.dbDriver, 3);
    // Automatyczne kopie tylko w środowisku produkcyjnym (nie w podglądach zmian / PR)
    const schedule =
      process.env.BACKUPS_ENABLED === '0'
        ? false
        : process.env.BACKUPS_ENABLED === '1' || cfg.environmentName === 'production' || (!cfg.environmentName && cfg.isProduction);
    backup = new BackupService({ adminPool, adminUrl, google, scheduleEnabled: schedule });
    backup.startScheduler();
    // dziennik błędów: przechowujemy 90 dni
    const pruneErrors = () =>
      adminPool!.query("DELETE FROM error_log WHERE at < now() - interval '90 days'").catch(() => {});
    void pruneErrors();
    setInterval(() => void pruneErrors(), 24 * 3600 * 1000).unref();
  } else {
    console.warn('Brak połączenia administracyjnego — kopie zapasowe i Google Drive są wyłączone.');
  }

  const server = http.createServer(createApp(db, cfg, { backup, google, adminPool }));
  server.listen(cfg.port, cfg.host, () => {
    console.log(
      `OpenAuto CRM działa: ${cfg.publicUrl ?? `http://localhost:${cfg.port}`} (port: ${cfg.port}, tryb: ${cfg.mode}` +
        `${cfg.environmentName ? `, środowisko: ${cfg.environmentName}` : ''})`,
    );
  });

  const shutdown = () => {
    console.log('Zamykanie…');
    backup?.stop();
    server.close(() => void Promise.all([db.end(), adminPool?.end()]).then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}
