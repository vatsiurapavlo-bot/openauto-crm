/**
 * Uruchomienie serwera bez migracji (gdy migracje wykonuje osobny krok).
 * DATABASE_URL = rola aplikacji; MIGRATION_DATABASE_URL (opcjonalnie) = połączenie administracyjne dla kopii.
 * Na Railway używany jest start.ts (migracje + serwer w jednym kroku).
 */
import { loadConfig } from './config.ts';
import { runServer } from './server.ts';

runServer({ cfg: loadConfig(), adminUrl: process.env.MIGRATION_DATABASE_URL ?? null }).catch((e) => {
  console.error(e);
  process.exit(1);
});
