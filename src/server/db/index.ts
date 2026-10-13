import type { PoolLike, Queryable } from './types.ts';

export type { Queryable, PoolLike } from './types.ts';

export interface DbContext {
  workspaceId: string;
  userId: string;
}

/**
 * Dostęp do bazy. Każde żądanie użytkownika wykonuje się w jednej transakcji,
 * z ustawionym app.workspace_id i app.user_id — na tej podstawie PostgreSQL (RLS)
 * decyduje, które wiersze i tabele są dostępne.
 */
export class Database {
  constructor(readonly pool: PoolLike) {}

  /** Zapytanie bez kontekstu użytkownika — tylko uwierzytelnianie i zadania systemowe. */
  system(): Queryable {
    return this.pool;
  }

  async tx<T>(ctx: DbContext | null, fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken: unknown;
    try {
      await client.query('BEGIN');
      if (ctx) {
        await client.query(
          "SELECT set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true)",
          [ctx.workspaceId, ctx.userId],
        );
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        broken = rollbackErr;
      }
      throw e;
    } finally {
      client.release(broken);
    }
  }

  end() {
    return this.pool.end();
  }
}

export async function createPool(databaseUrl: string, driver = process.env.DB_DRIVER ?? 'pg', max = 10): Promise<PoolLike> {
  if (driver === 'wire') {
    const { WirePool } = await import('./wire.ts');
    return new WirePool({ connectionString: databaseUrl, max });
  }
  const moduleName = 'pg'; // import dynamiczny: pakiet ładowany tylko gdy DB_DRIVER=pg
  const pg = ((await import(moduleName)) as any).default;
  // date → string 'YYYY-MM-DD' (bez przesunięć strefy czasowej)
  pg.types.setTypeParser(1082, (v: string) => v);
  return new pg.Pool({ connectionString: databaseUrl, max }) as PoolLike;
}
