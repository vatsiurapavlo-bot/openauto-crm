/**
 * Dodanie Właściciela do nowej przestrzeni (npm run setup) — istniejące konto tylko z jego obecnym hasłem.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, seedWorkspace, type Seeded, type TestDb } from '../helpers/db.ts';
import { ensureWorkspaceOwner } from '../../src/server/db/bootstrap.ts';

let t: TestDb;
let A: Seeded;
before(async () => {
  t = await createTestDatabase();
  A = await seedWorkspace(t.owner);
});
after(async () => {
  await t?.drop();
});

const role = (ws: string, user: string) =>
  t.owner
    .query<{ role_code: string }>(
      `SELECT m.role_code FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE w.code = $1 AND m.user_id = $2`,
      [ws, user],
    )
    .then((r) => r.rows[0]?.role_code);

test('istniejący e-mail bez jego hasła: odmowa, nikt nie zostaje właścicielem', async () => {
  await assert.rejects(
    ensureWorkspaceOwner(t.owner, {
      workspaceCode: 'ab-auto',
      workspaceName: 'AB Auto',
      email: A.users.viewer.email,
      name: 'Ktoś',
      password: 'Inne-haslo-2026',
    }),
    /już istnieje/,
  );
  assert.equal(await role('ab-auto', A.users.viewer.id), undefined);
  const ws = await t.owner.query('SELECT 1 FROM workspaces WHERE code = $1', ['ab-auto']);
  assert.equal(ws.rowCount, 0, 'cała operacja wycofana');
});

test('istniejące konto z poprawnym hasłem: właściciel drugiej przestrzeni, hasło bez zmian', async () => {
  await ensureWorkspaceOwner(t.owner, {
    workspaceCode: 'ab-auto',
    workspaceName: 'AB Auto',
    email: A.users.owner.email.toUpperCase(),
    name: 'Szef',
    password: A.users.owner.password,
  });
  assert.equal(await role('ab-auto', A.users.owner.id), 'owner');
  assert.equal(await role('openauto', A.users.owner.id), 'owner');
});
