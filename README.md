# OpenAuto CRM

CRM для купівлі, імпорту, ремонту й продажу вживаних автомобілів у Польщі.
Інтерфейс польською, валюта PLN, працює на комп'ютері, Android та iPhone (PWA).

**Поточний стан: Етап 1** — архітектура, база даних, авторизація, Dashboard і Samochody.
Що готово й що ні — [docs/ETAPY.md](docs/ETAPY.md). Архітектура — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 1. Запуск на Railway (рекомендовано)

Покрокова інструкція для людини без технічних знань: **[docs/RAILWAY.md](docs/RAILWAY.md)** —
акаунти, запуск, Google Drive, перевірка захисту, телефони, зміни через Claude, відкат і відновлення.
Вартість: близько 5 $ на місяць.

## 2. Власний сервер з Docker (альтернатива)

```bash
cp .env.example .env    # DB_OWNER_PASSWORD, DB_APP_PASSWORD, OPENAUTO_MASTER_KEY, DOMAIN
docker compose --profile https up -d --build
docker compose run --rm app node dist/server/setup.js     # перший власник
```

## 3. Запуск без Docker / розробка

```bash
npm install
cp .env.example .env          # заповніть DATABASE_URL, MIGRATION_DATABASE_URL, APP_DB_PASSWORD
# у PostgreSQL: CREATE ROLE openauto_owner LOGIN CREATEROLE PASSWORD '...';
#               CREATE DATABASE openauto OWNER openauto_owner;
set -a; . ./.env; set +a
npm run migrate               # міграції + роль openauto_app
npm run setup                 # перший власник
npm run build && npm start    # http://localhost:3000
```

Режим розробки з автоперезбиранням: `npm run dev`.

## 4. Змінні середовища

| Змінна | Призначення |
|---|---|
| `DATABASE_URL` | підключення застосунку — **роль `openauto_app`**, не власник таблиць |
| `MIGRATION_DATABASE_URL` | роль власника схеми — для `migrate` і `setup` |
| `APP_DB_USER`, `APP_DB_PASSWORD` | роль застосунку, яку створює `migrate` |
| `SECURE_COOKIES` | `1` = cookie лише через HTTPS (за замовчуванням у продакшені) |
| `TRUST_PROXY` | `1`, якщо застосунок за reverse proxy |
| `SESSION_TTL_HOURS` | тривалість сесії (за замовч. 12 год, продовжується при активності) |

У продакшені сервер **не запуститься**, якщо `DATABASE_URL` вказує на роль, що обходить Row-Level Security.

## 5. Користувачі та ролі

Власник додає працівників у розділі **Użytkownicy** (тимчасовий пароль передається особисто;
працівник змінює його в **Ustawienia**). Ролі: Właściciel, Administrator, Manager, Sprzedawca, Serwis,
Lakiernia, Księgowość, Podgląd. Права перевіряє сервер **і база даних**:

- *Serwis* / *Lakiernia* бачать лише авто у своєму статусі й можуть змінювати тільки статус;
- фінанси авто, каса, витрати й журнал змін недоступні ролям без відповідних прав.

Запрошення посиланням і редагування прав ролей — Етап 6.

## 6. Робочий простір AB Auto (у майбутньому)

```bash
WORKSPACE_CODE=ab-auto WORKSPACE_NAME="AB Auto" docker compose run --rm app node dist/server/setup.js
```

Створює окремий простір із власними авто, касою, нумерацією та користувачами. Інтерфейс перемикання між
просторами — Етап 6.

## 7. Тести

```bash
export TEST_ADMIN_DATABASE_URL=postgres://postgres:ПАРОЛЬ@127.0.0.1:5432/postgres
npm run build
npx playwright install chromium      # один раз, для тестів у браузері
npm test                             # 63 тести: unit, БД (RLS), API, копії, браузер
npm run typecheck
```

Тести створюють і видаляють власні тимчасові бази, робочі дані не зачіпають.

## 8. Резервні копії

- **Автоматично щоночі:** зашифрована (AES-256-GCM) копія всієї бази в Google Drive, папка
  `OpenAuto CRM/Backups`, 60 останніх. Стан і кнопка «Utwórz kopię teraz» — у Ustawienia (лише власник).
- **Знімки Railway:** Postgres → Backups (щодня/щотижня), відновлення в один клік.
- **Відновлення з файлу `.oabak`:** `OPENAUTO_MASTER_KEY=… DATABASE_URL=… node dist/server/restore.js файл.oabak`
  (перевірено автотестом: копія → нова база → дані й лічильник номерів збережені).

## 9. Перенесення на інший сервер

Копіювання папки програми **не** переносить базу даних. Повне перенесення:

1. На старому сервері: резервна копія бази (розділ 8) і файл `.env`.
2. На новому сервері: `git clone`, покласти `.env`, `docker compose up -d db`.
3. Відновити копію (розділ 8), потім `docker compose --profile https up -d --build`.
4. Змінити DNS домену на новий IP.

Фото й документи (з Етапу 2) зберігаються в Google Drive і не потребують перенесення.
