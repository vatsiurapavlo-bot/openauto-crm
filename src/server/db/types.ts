export interface QueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

export interface Queryable {
  query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface PoolClientLike extends Queryable {
  release(err?: unknown): void;
}

/** Interfejs zgodny z pg.Pool — ten sam kod działa z `pg` i z klientem testowym. */
export interface PoolLike extends Queryable {
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
}
