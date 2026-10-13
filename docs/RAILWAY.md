# OpenAuto CRM на Railway — інструкція для власника

Після цих кроків CRM відкривається за одним посиланням `https://….up.railway.app` на комп'ютері,
iPhone та Android. Нічого не потрібно встановлювати на свій комп'ютер. Назви кнопок у Railway й Google
можуть трохи відрізнятися — сервіси часом оновлюють вигляд.

Загальний час: близько 1,5–2 годин один раз.

---

## 0. Що потрібно і скільки коштує

| Сервіс | Для чого | Вартість на місяць |
|---|---|---|
| **Railway, план Hobby** | CRM + база PostgreSQL + знімки бази | **5 $** (включає 5 $ використання) |
| GitHub Free | приватне сховище коду, автоматичні тести | 0 |
| Google (Gmail) | Drive: копії, пізніше фото й документи | 0 (15 ГБ безкоштовно) |
| Домен (необов'язково, пізніше) | адреса типу `crm.openauto.pl` | річна оплата реєстратору |

**Розрахунок Railway** за виміряним споживанням цієї CRM (сервер ≈ 70 МБ пам'яті, база ≈ 100 МБ,
процесор майже не навантажений) і цінами Railway (пам'ять 10 $/ГБ, процесор 20 $/vCPU, диск 0,15 $/ГБ,
трафік 0,05 $/ГБ на місяць):

| Складова | Оцінка |
|---|---|
| Сервер CRM (~0,1 ГБ пам'яті) | ≈ 1,0 $ |
| PostgreSQL (~0,15–0,2 ГБ пам'яті) | ≈ 1,5–2,0 $ |
| Процесор (у середньому 1–3 % ядра) | ≈ 0,2–0,6 $ |
| Диск бази 1 ГБ + знімки | ≈ 0,2–0,3 $ |
| Трафік | ≈ 0,1 $ |
| **Разом використання** | **≈ 3–4 $ → покривається 5 $ плану** |

Отже реально: **5 $ на місяць**. Якщо додати постійне тестове середовище (див. розділ 8) або
CRM буде дуже активно використовуватися — **7–10 $**. Railway може додати ПДВ залежно від даних
рахунку. Збірки програми Railway не тарифікує. Тарифний план Pro (20 $) зараз не потрібен; він дає довше
вікно відкату (120 год замість 72) і роботу в команді.

---

## 1. Акаунти (≈ 30 хв)

### 1.1 Окремий Google-акаунт для CRM
1. Створіть новий Gmail лише для CRM (наприклад, з назвою фірми в адресі).
2. Увімкніть двоетапну перевірку (Google-акаунт → Безпека).

Чому окремий: копії й документи CRM живуть окремо від особистої пошти, і доступ до них можна передати
бухгалтеру чи партнеру, не відкриваючи особисті файли.

### 1.2 GitHub (сховище коду)
1. github.com → **Sign up** → створіть акаунт, увімкніть двоетапну перевірку.
2. **New repository** → назва `openauto-crm` → **Private** → нічого не додавайте → **Create repository**.
3. Дайте Claude доступ: у налаштуваннях Claude → **Connectors** → **GitHub** → підключити.
4. Напишіть Claude: «Репозиторій створено: `<ваш-логін>/openauto-crm`». Claude завантажить код.

### 1.3 Railway
1. railway.com → **Login** → **Continue with GitHub** (вхід через щойно створений GitHub).
2. Оберіть план **Hobby** і додайте картку.

---

## 2. Запуск CRM у Railway (≈ 20 хв)

1. **New Project → Deploy from GitHub repo → `openauto-crm`.** Перша спроба запуску може завершитися
   помилкою — це нормально, ще немає бази.
2. У проєкті: **Create → Database → PostgreSQL**.
3. Відкрийте сервіс **openauto-crm → Variables** і додайте:

   | Змінна | Значення |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (саме так, з дужками — це посилання на базу) |
   | `BOOTSTRAP_OWNER_EMAIL` | ваш e-mail для входу в CRM |
   | `BOOTSTRAP_OWNER_NAME` | ваше ім'я та прізвище |
   | `BOOTSTRAP_OWNER_PASSWORD` | **тимчасовий** пароль (мін. 10 символів, літери й цифри) |

   Натисніть **Deploy** (або **Apply changes**).
4. **openauto-crm → Settings → Networking → Generate Domain.** Отримаєте адресу CRM.
5. **openauto-crm → Settings → Deploy → Healthcheck Path:** `/api/health`.
6. **Регіон:** в Settings обох сервісів (openauto-crm і Postgres) оберіть Європу (EU West).
7. **Postgres → Backups:** додайте розклад **Daily** і **Weekly** (знімки бази всередині Railway).
8. **Postgres → Settings → Networking:** якщо є **TCP Proxy** (публічний доступ до бази) — видаліть його.
   CRM з'єднується з базою внутрішньою мережею, публічний доступ не потрібен.

9. **openauto-crm → Settings → Source → «Wait for CI»** — увімкніть. Тоді Railway оновлює CRM лише після
   того, як автоматичні тести в GitHub пройшли успішно. (Перемикач з'являється після першого запуску тестів.)

Під час запуску CRM сама створює таблиці, окрему обмежену роль бази даних і ваш акаунт власника.

---

## 3. Перший вхід (5 хв)

1. Відкрийте адресу з кроку 2.4, увійдіть тимчасовим паролем. CRM одразу попросить встановити власний.
2. Railway → openauto-crm → Variables → **видаліть `BOOTSTRAP_OWNER_PASSWORD`**.
3. CRM → **Ustawienia → Google Drive i kopie zapasowe → «Wygeneruj klucz»**. З'явиться ключ шифрування.
   - Збережіть його **у двох місцях поза Railway**: у менеджері паролів (Bitwarden, 1Password, Keychain)
     і на папері в сейфі. **Без цього ключа резервні копії з Google Drive не відкрити.**
   - Railway → Variables → додайте `OPENAUTO_MASTER_KEY` = цей ключ. CRM перезапуститься (~1 хв).

---

## 4. Google Drive для копій і документів (≈ 20 хв)

Усе в цьому розділі робіть, увійшовши в **Gmail для CRM** (крок 1.1).

1. console.cloud.google.com → створіть проєкт **OpenAuto CRM**.
2. **APIs & Services → Library →** знайдіть **Google Drive API** → **Enable**.
3. **Google Auth Platform** (або **OAuth consent screen**) → **Get started**: назва `OpenAuto CRM`,
   e-mail підтримки — Gmail для CRM, **Audience: External**, контактний e-mail → **Create**.
4. **Data Access → Add or remove scopes →** позначте `.../auth/drive.file` → **Save**.
   Це найвужчий доступ: CRM бачитиме лише власну папку «OpenAuto CRM», а не весь Диск.
5. **Audience → Publish app → In production.** Важливо: у тестовому режимі Google відключає доступ через
   7 днів, і копії перестали б створюватися.
6. **Clients → Create client → Web application:**
   - Authorized redirect URIs: `https://<ваша-адреса>/api/integrations/google/callback`
   - **Create** → скопіюйте **Client ID** і **Client secret**.
7. Railway → openauto-crm → Variables: `GOOGLE_CLIENT_ID` і `GOOGLE_CLIENT_SECRET`.
8. CRM → **Ustawienia → Połącz Google Drive** → оберіть Gmail для CRM → дозвольте доступ. Якщо Google
   попередить, що застосунок не перевірено, — це ваш власний застосунок: «Додатково» → «Перейти до OpenAuto CRM».
9. Натисніть **«Utwórz kopię teraz»**. На Диску з'явиться `OpenAuto CRM/Backups/openauto-backup-….oabak`.

Далі копія створюється **автоматично щоночі після 2:00**, зберігаються 60 останніх.

---

## 5. Перевірка захисту і запуск з реальними даними

До цього моменту CRM показує жовтий банер **«Tryb testowy»** — не вносьте реальні дані.

1. CRM → **Ustawienia → Kontrola przed uruchomieniem**. Усі пункти мають бути з зеленою позначкою:
   HTTPS, захищене cookie, обмежена роль бази, власний пароль, ключ шифрування, Google Drive, свіжа копія,
   автоматичні копії.
2. Напишіть Claude: «Перевір запуск: `<адреса>`». Claude перевірить CRM ззовні
   (`scripts/check-launch.mjs`) і скаже, чи все гаразд.
3. Позначте три ручні пункти (знімки Railway увімкнені, база без публічного доступу, ключ збережено) і
   натисніть **«Zatwierdzam uruchomienie z prawdziwymi danymi»**. Банер зникне; рішення записується в журнал.

---

## 6. Телефони

- **iPhone:** Safari → відкрийте адресу → кнопка «Поділитися» → **«На початковий екран»**.
- **Android:** Chrome → ⋮ → **«Встановити застосунок»** / «Додати на головний екран».

Працівникам: Użytkownicy → Dodaj użytkownika → тимчасовий пароль передайте особисто;
при першому вході система змусить змінити його.

---

## 7. Щоденне обслуговування

Робити нічого не потрібно. Раз на тиждень загляньте в **Ustawienia → Ostatnia udana kopia** — дата має бути
вчорашньою або сьогоднішньою. Якщо ні — напишіть Claude.

---

## 8. Зміни в програмі через Claude

1. Опишіть Claude, що хочете змінити.
2. Claude робить зміну в окремій гілці, запускає всі автотести й відкриває **Pull Request** у GitHub з
   поясненням і скріншотами.
3. GitHub ще раз автоматично запускає тести (≈ 10 хв). Результат видно в PR (зелена позначка).
4. Якщо все влаштовує — у PR натисніть **Merge pull request**. Лише після цього Railway дочекається
   тестів і оновить CRM (3–5 хв, без перерви в роботі). Без вашого Merge зміни не публікуються.

**Тестове середовище (за бажанням, +2–4 $/міс):** окрема копія CRM з порожньою базою, де можна самому
поклацати зміну до Merge. Налаштуємо, якщо скріншотів буде недостатньо. Автоматичні PR-середовища Railway
не вмикайте без цього: вони копіюють секрети робочої CRM.

---

## 9. Якщо щось пішло не так

**Нова версія працює погано — відкат:** Railway → openauto-crm → **Deployments** → попередня робоча версія →
⋮ → **Rollback**. На плані Hobby відкат можливий у межах 72 годин; старіші версії — **Redeploy**.
Дані в базі при відкаті не змінюються.

**Потрібно відновити дані:**
- швидко (той самий проєкт): Railway → Postgres → **Backups** → потрібна дата → **Restore** → **Deploy**;
- з Google Drive (наприклад, втрачено доступ до Railway): напишіть Claude — він відновить базу з файлу
  `.oabak` за допомогою вашого ключа шифрування (`src/server/cli/restore.ts`).

**CRM не відкривається:** Railway → openauto-crm → Deployments → **View logs** → скопіюйте останні рядки
й надішліть Claude.

---

## Довідка: змінні Railway

| Змінна | Обов'язкова | Опис |
|---|---|---|
| `DATABASE_URL` | так | `${{Postgres.DATABASE_URL}}` |
| `OPENAUTO_MASTER_KEY` | так (крок 3) | ключ шифрування копій і токена Google; зберігати поза Railway |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | для Drive | з Google Cloud (крок 4) |
| `BOOTSTRAP_OWNER_EMAIL`, `…_NAME`, `…_PASSWORD` | лише перший запуск | акаунт власника; пароль видалити після входу |
| `OPENAUTO_MODE` | ні | `production` — альтернатива підтвердженню в CRM |
| `PUBLIC_URL` | ні | лише для власного домену (Railway-адресу CRM визначає сама) |
| `BACKUPS_ENABLED` | ні | `0` вимикає, `1` примусово вмикає автоматичні копії |

Джерела цін і можливостей: Railway — [ціни](https://docs.railway.com/pricing/plans),
[знімки томів](https://docs.railway.com/reference/backups), [Wait for CI](https://docs.railway.com/deployments/github-autodeploys),
[відкат](https://docs.railway.com/guides/roll-back-bad-deploy); Google —
[термін дії токенів](https://developers.google.com/identity/protocols/oauth2),
[область drive.file](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).
