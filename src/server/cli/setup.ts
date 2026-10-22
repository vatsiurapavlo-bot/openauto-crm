/**
 * npm run setup — pierwsze uruchomienie: tworzy przestrzeń roboczą (domyślnie OpenAuto)
 * z rolami, statusami i słownikami oraz konto Właściciela.
 *
 *   OWNER_EMAIL=... OWNER_NAME="Jan Kowalski" npm run setup
 * Hasło: zmienna OWNER_PASSWORD albo zostaniesz o nie zapytany.
 * Później w ten sam sposób można dodać przestrzeń AB Auto (WORKSPACE_CODE=ab-auto).
 * Jeśli konto z tym e-mailem już istnieje, podaj jego OBECNE hasło — inaczej setup odmówi.
 */
import readline from 'node:readline';
import { createPool } from '../db/index.ts';
import { validatePasswordStrength } from '../auth/password.ts';
import { ensureWorkspaceOwner } from '../db/bootstrap.ts';

function ask(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    (rl as any)._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(s);
      else process.stdout.write('*');
    };
  }
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(a.trim());
    }),
  );
}

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('Ustaw MIGRATION_DATABASE_URL (zobacz .env.example)');
  process.exit(1);
}

const wsCode = process.env.WORKSPACE_CODE ?? 'openauto';
const wsName = process.env.WORKSPACE_NAME ?? 'OpenAuto';
const email = (process.env.OWNER_EMAIL ?? (await ask('E-mail właściciela: '))).toLowerCase();
const name = process.env.OWNER_NAME ?? (await ask('Imię i nazwisko: '));
let password = process.env.OWNER_PASSWORD ?? '';
if (!password) {
  password = await ask('Hasło (min. 10 znaków, litery i cyfry): ', true);
  const again = await ask('Powtórz hasło: ', true);
  if (password !== again) {
    console.error('Hasła się różnią');
    process.exit(1);
  }
}
const weak = validatePasswordStrength(password);
if (weak) {
  console.error(weak);
  process.exit(1);
}

const pool = await createPool(url, process.env.DB_DRIVER ?? 'pg', 1);
try {
  const r = await ensureWorkspaceOwner(pool, { workspaceCode: wsCode, workspaceName: wsName, email, name, password });
  if (r.createdWorkspace) console.log(`Utworzono przestrzeń roboczą ${wsName} (${wsCode})`);
  console.log(`Właściciel ${email} ma dostęp do ${wsName}. Możesz się zalogować.`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
