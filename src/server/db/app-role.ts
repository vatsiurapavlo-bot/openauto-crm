/**
 * Hasło roli aplikacji (`openauto_app`) — STAŁE między uruchomieniami i wdrożeniami.
 *
 * Dawniej bez OPENAUTO_MASTER_KEY hasło było losowane przy każdym starcie. Na Railway nowa wersja
 * uruchamia się, gdy poprzednia jeszcze działa: nowa zmieniała hasło w bazie, a poprzednia przy
 * otwieraniu kolejnych połączeń dostawała „password authentication failed for user openauto_app”.
 *
 * Teraz hasło jest wyprowadzane (HKDF-SHA256) z hasła połączenia administracyjnego (DATABASE_URL):
 *  - jest stałe, dopóki Railway nie zmieni hasła bazy (wtedy wszystkie instancje i tak muszą się zrestartować),
 *  - nie zależy od OPENAUTO_MASTER_KEY — dodanie lub zmiana klucza nie wpływa na logowanie do bazy,
 *  - nie daje nic nowego komuś, kto zna hasło administracyjne (ten i tak ma pełny dostęp do bazy).
 * Jawnie ustawione APP_DB_PASSWORD (np. docker-compose) ma pierwszeństwo.
 */
import crypto from 'node:crypto';

export function deriveAppRolePassword(adminUrl: string, explicit = process.env.APP_DB_PASSWORD): string {
  if (explicit) return explicit;
  const u = new URL(adminUrl);
  const adminSecret = decodeURIComponent(u.password);
  if (!adminSecret) throw new Error('DATABASE_URL nie zawiera hasła — nie można wyznaczyć hasła roli aplikacji');
  // sól wiąże wynik z konkretną bazą (host + nazwa), więc różne bazy dostają różne hasła
  const salt = `openauto-crm:${u.hostname}:${u.port || '5432'}${u.pathname}`;
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(adminSecret, 'utf8'), Buffer.from(salt), Buffer.from('db-app-role-v2'), 32)).toString(
    'base64url',
  );
}

export function withCredentials(url: string, user: string, password: string) {
  const u = new URL(url);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  return u.toString();
}
