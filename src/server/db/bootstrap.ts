import type { PoolLike } from './types.ts';
import { hashPassword, validatePasswordStrength } from '../auth/password.ts';

export interface OwnerInput {
  workspaceCode: string;
  workspaceName: string;
  email: string;
  name: string;
  password: string;
  /** true = hasło tymczasowe, wymuszona zmiana przy pierwszym logowaniu */
  mustChangePassword?: boolean;
}

/** Tworzy przestrzeń roboczą (jeśli nie istnieje) i nadaje użytkownikowi rolę Właściciel. */
export async function ensureWorkspaceOwner(pool: PoolLike, input: OwnerInput): Promise<{ createdWorkspace: boolean }> {
  const weak = validatePasswordStrength(input.password);
  if (weak) throw new Error(weak);
  const email = input.email.trim().toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let createdWorkspace = false;
    let ws = (await client.query<{ id: string }>('SELECT id FROM workspaces WHERE code = $1', [input.workspaceCode])).rows[0];
    if (!ws) {
      ws = (
        await client.query<{ id: string }>('INSERT INTO workspaces (code, name) VALUES ($1, $2) RETURNING id', [
          input.workspaceCode,
          input.workspaceName,
        ])
      ).rows[0];
      await client.query('SELECT init_workspace($1)', [ws.id]);
      createdWorkspace = true;
    }
    let user = (await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0];
    if (!user) {
      user = (
        await client.query<{ id: string }>(
          'INSERT INTO users (email, full_name, password_hash, must_change_password) VALUES ($1, $2, $3, $4) RETURNING id',
          [email, input.name, await hashPassword(input.password), input.mustChangePassword ?? false],
        )
      ).rows[0];
    }
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role_code) VALUES ($1, $2, 'owner')
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role_code = 'owner', active = true`,
      [ws.id, user.id],
    );
    await client.query('COMMIT');
    return { createdWorkspace };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Pierwsze uruchomienie bez wiersza poleceń: jeśli w bazie NIE MA jeszcze żadnego użytkownika,
 * a ustawiono BOOTSTRAP_OWNER_EMAIL i BOOTSTRAP_OWNER_PASSWORD — tworzy OpenAuto i konto Właściciela.
 * Gdy użytkownicy już istnieją, nic nie robi (zmienne można bezpiecznie zostawić, hasło i tak trzeba zmienić).
 */
export async function bootstrapFromEnv(pool: PoolLike, env = process.env, log = console.log): Promise<boolean> {
  const email = env.BOOTSTRAP_OWNER_EMAIL;
  const password = env.BOOTSTRAP_OWNER_PASSWORD;
  if (!email || !password) return false;
  const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM users');
  if (Number(rows[0].n) > 0) return false;
  await ensureWorkspaceOwner(pool, {
    workspaceCode: env.WORKSPACE_CODE ?? 'openauto',
    workspaceName: env.WORKSPACE_NAME ?? 'OpenAuto',
    email,
    name: env.BOOTSTRAP_OWNER_NAME ?? 'Właściciel',
    password,
    mustChangePassword: true,
  });
  log(`Utworzono konto Właściciela ${email.toLowerCase()} — przy pierwszym logowaniu system wymusi zmianę hasła.`);
  return true;
}
