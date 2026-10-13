import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decrypt, encrypt, masterKeyStatus, signState, verifyState, MasterKeyError } from '../../src/server/crypto/secrets.ts';

const KEY = 'test-master-key-0123456789-abcdefghijklmnop';

test('szyfrowanie kopii: odszyfrowanie tym samym kluczem, odrzucenie złego klucza i zmienionego pliku', () => {
  const plain = Buffer.from('PGDMP… dane bazy '.repeat(100));
  const sealed = encrypt(plain, 'backup', KEY);
  assert.ok(!sealed.includes(Buffer.from('dane bazy')), 'treść nie może być jawna');
  assert.deepEqual(decrypt(sealed, 'backup', KEY), plain);
  assert.throws(() => decrypt(sealed, 'backup', KEY + 'x'), MasterKeyError);
  assert.throws(() => decrypt(sealed, 'token', KEY), MasterKeyError, 'inny cel = inny klucz');
  const tampered = Buffer.from(sealed);
  tampered[40] ^= 1;
  assert.throws(() => decrypt(tampered, 'backup', KEY), MasterKeyError);
  assert.throws(() => decrypt(Buffer.from('zwykły plik'), 'backup', KEY), /nie jest plik/);
  // każde szyfrowanie ma inny wektor IV
  assert.notDeepEqual(encrypt(plain, 'backup', KEY), sealed);
});

test('klucz główny: wymagany i odpowiednio długi', () => {
  assert.equal(masterKeyStatus(undefined), 'missing');
  assert.equal(masterKeyStatus('krotki'), 'too_short');
  assert.equal(masterKeyStatus(KEY), 'ok');
  assert.equal(masterKeyStatus('a'.repeat(64)), 'too_short', 'klucz bez losowości odrzucony');
  assert.equal(masterKeyStatus('12341234123412341234123412341234'), 'too_short');
  assert.throws(() => encrypt(Buffer.from('x'), 'backup', 'krotki'), /co najmniej 32/);
});

test('podpisany parametr state (OAuth): weryfikacja, podróbka, wygaśnięcie', () => {
  process.env.OPENAUTO_MASTER_KEY = KEY;
  const s = signState({ u: 'user-1' });
  assert.deepEqual(verifyState<{ u: string }>(s)?.u, 'user-1');
  const [body] = s.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 'admin', exp: 9e9 })).toString('base64url') + '.' + s.split('.')[1];
  assert.equal(verifyState(forged), null);
  assert.equal(verifyState(body + '.xxx'), null);
  assert.equal(verifyState(signState({ u: 'x' }, -1)), null);
});
