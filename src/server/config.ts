import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  dbDriver: 'pg' | 'wire';
  publicDir: string;
  secureCookies: boolean;
  sessionTtlHours: number;
  isProduction: boolean;
  allowInsecureDbRole: boolean;
  /** Publiczny adres aplikacji (np. https://openauto-crm.up.railway.app) — potrzebny do logowania Google */
  publicUrl: string | null;
  /** Za proxy (Railway): adres klienta z nagłówka X-Real-IP, który Railway nadpisuje na brzegu sieci */
  trustProxy: boolean;
  /** 'test' = baner „tryb testowy”; 'production' dopiero po kontroli bezpieczeństwa i decyzji właściciela */
  mode: 'test' | 'production';
  /** Nazwa środowiska Railway (production, pr-12…) — automatyczne kopie tylko w produkcji */
  environmentName: string | null;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Brak zmiennej środowiskowej ${name} (zobacz .env.example)`);
  return v;
}

export function loadConfig(databaseUrl?: string): Config {
  const isProduction = process.env.NODE_ENV === 'production';
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  return {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '0.0.0.0',
    databaseUrl: databaseUrl ?? required('DATABASE_URL'),
    dbDriver: (process.env.DB_DRIVER as 'pg' | 'wire') ?? 'pg',
    publicDir: process.env.PUBLIC_DIR ?? path.resolve('dist/public'),
    secureCookies: process.env.SECURE_COOKIES ? process.env.SECURE_COOKIES === '1' : isProduction,
    sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
    isProduction,
    allowInsecureDbRole: process.env.ALLOW_INSECURE_DB_ROLE === '1',
    publicUrl: process.env.PUBLIC_URL ?? (railwayDomain ? `https://${railwayDomain}` : null),
    trustProxy: process.env.TRUST_PROXY ? process.env.TRUST_PROXY === '1' : !!process.env.RAILWAY_ENVIRONMENT_NAME,
    mode: process.env.OPENAUTO_MODE === 'production' ? 'production' : 'test',
    environmentName: process.env.RAILWAY_ENVIRONMENT_NAME ?? null,
  };
}
