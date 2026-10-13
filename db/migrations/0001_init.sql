-- =============================================================================
-- OpenAuto CRM — migracja 0001: pełny schemat bazy danych
--
-- Zasady:
--  * Każda tabela biznesowa ma workspace_id (OpenAuto teraz, AB Auto w przyszłości).
--  * Dostęp do danych egzekwuje PostgreSQL (Row-Level Security), nie tylko UI.
--    Aplikacja łączy się rolą bez uprawnień właściciela tabel i bez BYPASSRLS,
--    a w każdej transakcji ustawia app.workspace_id i app.user_id.
--  * Kwoty pieniężne: NUMERIC(14,2) — nigdy float.
--  * Niczego nie kasujemy fizycznie: rola aplikacji nie ma prawa DELETE na danych
--    biznesowych (wyjątek: sesje). Usunięcie = deleted_at / cancelled_at.
--  * Tabele modułów z późniejszych etapów (koszty, kasa, VAT, aukcje, import)
--    są zdefiniowane już teraz, aby architektura była spójna; logika w etapach 3–5.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Przestrzenie robocze, użytkownicy, role, uprawnienia
-- ----------------------------------------------------------------------------

CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9-]{2,40}$'),
  name        text NOT NULL,
  currency    char(3) NOT NULL DEFAULT 'PLN',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL CHECK (email = lower(email) AND position('@' in email) > 1),
  full_name      text NOT NULL,
  password_hash  text,                       -- scrypt; NULL = konto bez hasła (zaproszenie)
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);
CREATE UNIQUE INDEX users_email_uq ON users (email);

CREATE TABLE roles (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  code         text NOT NULL CHECK (code ~ '^[a-z_]{2,40}$'),
  name         text NOT NULL,
  is_system    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, code)
);

CREATE TABLE role_permissions (
  workspace_id uuid NOT NULL,
  role_code    text NOT NULL,
  permission   text NOT NULL,
  PRIMARY KEY (workspace_id, role_code, permission),
  FOREIGN KEY (workspace_id, role_code) REFERENCES roles(workspace_id, code)
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  role_code    text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id, role_code) REFERENCES roles(workspace_id, code)
);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    bytea NOT NULL UNIQUE,          -- SHA-256 tokenu; sam token tylko w ciasteczku
  user_id       uuid NOT NULL REFERENCES users(id),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  ip            text,
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Zaproszenia przez indywidualny link (logika: Etap 6)
CREATE TABLE invitations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  email         text NOT NULL CHECK (email = lower(email)),
  role_code     text NOT NULL,
  token_hash    bytea NOT NULL UNIQUE,
  landing_path  text,                           -- np. '/serwis'
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  revoked_at    timestamptz,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, role_code) REFERENCES roles(workspace_id, code)
);

-- Liczniki numerów (Numer auta, numer kosztu, numer operacji kasowej).
-- Licznik tylko rośnie, więc numery nigdy nie są używane ponownie.
CREATE TABLE workspace_counters (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name         text NOT NULL,
  last_value   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, name)
);

-- ----------------------------------------------------------------------------
-- 2. Funkcje kontekstu i uprawnień (używane przez polityki RLS)
-- ----------------------------------------------------------------------------

CREATE FUNCTION app_workspace() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.workspace_id', true), '')::uuid
$$;

CREATE FUNCTION app_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- Rola bieżącego użytkownika w bieżącej przestrzeni (NULL = brak członkostwa)
CREATE FUNCTION app_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.role_code
  FROM workspace_members m JOIN users u ON u.id = m.user_id
  WHERE m.workspace_id = app_workspace() AND m.user_id = app_user()
    AND m.active AND u.is_active
$$;

CREATE FUNCTION app_has_perm(p text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.workspace_id = app_workspace() AND rp.role_code = app_role() AND rp.permission = p
  )
$$;

CREATE FUNCTION app_next_number(p_workspace uuid, p_name text) RETURNS bigint
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO workspace_counters AS c (workspace_id, name, last_value)
  VALUES (p_workspace, p_name, 1)
  ON CONFLICT (workspace_id, name) DO UPDATE SET last_value = c.last_value + 1
  RETURNING last_value
$$;

-- ----------------------------------------------------------------------------
-- 3. Słowniki: statusy, kraje, stawki VAT, kategorie kosztów
-- ----------------------------------------------------------------------------

-- Trzy niezależne wymiary statusu:
--   logistic   — gdzie jest auto (Na placu, W drodze, Serwis, Lakiernia, Problem)
--   sales      — sprzedaż (Przygotowanie, W sprzedaży, Zarezerwowany, Sprzedany)
--   settlement — rozliczenie (Otwarte, Rozliczone)
CREATE TABLE car_statuses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  kind          text NOT NULL CHECK (kind IN ('logistic', 'sales', 'settlement')),
  system_code   text,                         -- NULL = status własny użytkownika
  name          text NOT NULL,
  color         text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  sort_order    int NOT NULL DEFAULT 100,
  is_closed     boolean NOT NULL DEFAULT false, -- tylko settlement: auto rozliczone
  is_default    boolean NOT NULL DEFAULT false,
  active        boolean NOT NULL DEFAULT true,
  UNIQUE (workspace_id, kind, system_code),
  UNIQUE (workspace_id, kind, name),
  CHECK (NOT is_closed OR kind = 'settlement')
);
CREATE UNIQUE INDEX car_statuses_one_default ON car_statuses (workspace_id, kind) WHERE is_default;

-- Ograniczenie widoczności aut dla roli (np. Serwis widzi tylko auta w statusie Serwis).
-- Brak wierszy dla roli = rola widzi wszystkie auta.
CREATE TABLE role_status_scope (
  workspace_id uuid NOT NULL,
  role_code    text NOT NULL,
  status_id    uuid NOT NULL REFERENCES car_statuses(id),
  PRIMARY KEY (workspace_id, role_code, status_id),
  FOREIGN KEY (workspace_id, role_code) REFERENCES roles(workspace_id, code)
);

CREATE FUNCTION app_car_visible(p_logistic_status uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT NOT EXISTS (
           SELECT 1 FROM role_status_scope s
           WHERE s.workspace_id = app_workspace() AND s.role_code = app_role())
      OR EXISTS (
           SELECT 1 FROM role_status_scope s
           WHERE s.workspace_id = app_workspace() AND s.role_code = app_role()
             AND s.status_id = p_logistic_status)
$$;

CREATE TABLE countries (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  code         char(2) NOT NULL CHECK (code ~ '^[A-Z]{2}$'),
  name         text NOT NULL,
  currency     char(3),
  active       boolean NOT NULL DEFAULT true,
  sort_order   int NOT NULL DEFAULT 100,
  PRIMARY KEY (workspace_id, code)
);

CREATE TABLE vat_rates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  label         text NOT NULL,
  rate          numeric(7,4) NOT NULL CHECK (rate >= 0 AND rate < 1),
  valid_from    date NOT NULL DEFAULT DATE '2000-01-01',
  valid_to      date,
  active        boolean NOT NULL DEFAULT true,
  sort_order    int NOT NULL DEFAULT 100,
  UNIQUE (workspace_id, label, valid_from)
);

CREATE TABLE cost_categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  system_code   text,
  name          text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  sort_order    int NOT NULL DEFAULT 100,
  UNIQUE (workspace_id, name)
);

-- ----------------------------------------------------------------------------
-- 4. Samochody
-- ----------------------------------------------------------------------------

CREATE TABLE cars (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces(id),
  numer                  bigint NOT NULL,       -- "Numer auta": 1, 2, 3… nadawany przez trigger
  marka                  text NOT NULL CHECK (length(trim(marka)) > 0),
  model                  text NOT NULL CHECK (length(trim(model)) > 0),
  wersja                 text,
  rok_produkcji          int CHECK (rok_produkcji BETWEEN 1900 AND 2100),
  vin                    text CHECK (vin IS NULL OR vin ~ '^[A-HJ-NPR-Z0-9]{11,17}$'),
  numer_rejestracyjny    text,
  przebieg_km            int CHECK (przebieg_km >= 0),
  pojemnosc_cm3          int CHECK (pojemnosc_cm3 >= 0),
  moc_km                 int CHECK (moc_km >= 0),
  rodzaj_paliwa          text,
  skrzynia_biegow        text,
  kolor                  text,
  data_zakupu            date,
  data_przyjazdu         date,
  data_sprzedazy         date,
  typ_zakupu             text,
  -- kraje przechowywane osobno — nie zakładamy, że są takie same (p. 15.4)
  kraj_zakupu            char(2),
  kraj_rejestracji       char(2),
  kraj_lokalizacji       char(2),
  kraj_sprzedawcy        char(2),
  kraj_faktury           char(2),
  -- ceny ofertowe (widoczne na kartach; nie są danymi kosztowymi)
  cena_a                 numeric(14,2) CHECK (cena_a >= 0),
  cena_b                 numeric(14,2) CHECK (cena_b >= 0),
  logistic_status_id     uuid NOT NULL REFERENCES car_statuses(id),
  sales_status_id        uuid NOT NULL REFERENCES car_statuses(id),
  settlement_status_id   uuid NOT NULL REFERENCES car_statuses(id),
  notatka                text,
  main_photo_file_id     uuid,                  -- FK dodany niżej (files)
  version                int NOT NULL DEFAULT 1, -- blokada optymistyczna (wielu użytkowników)
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  deleted_by             uuid REFERENCES users(id),
  UNIQUE (workspace_id, numer)
);
CREATE UNIQUE INDEX cars_vin_uq ON cars (workspace_id, vin) WHERE vin IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX cars_ws_status_idx ON cars (workspace_id, logistic_status_id) WHERE deleted_at IS NULL;
CREATE INDEX cars_search_idx ON cars USING gin (
  to_tsvector('simple', coalesce(marka,'') || ' ' || coalesce(model,'') || ' ' || coalesce(vin,'') || ' ' || coalesce(numer_rejestracyjny,''))
);

-- Dane finansowe auta — osobna tabela, żeby RLS mógł je ukryć przed rolami bez uprawnień
CREATE TABLE car_finance (
  car_id                   uuid PRIMARY KEY REFERENCES cars(id),
  workspace_id             uuid NOT NULL REFERENCES workspaces(id),
  wartosc_auta             numeric(14,2) CHECK (wartosc_auta >= 0),  -- cena zakupu w PLN
  waluta_zakupu            char(3) NOT NULL DEFAULT 'PLN',
  cena_zakupu_waluta       numeric(14,2),
  kurs_waluty              numeric(14,6),
  uslugi_aukcji_netto      numeric(14,2),
  vat_na_uslugi            numeric(14,2),
  akcyza_pcc               numeric(14,2),
  tryb_zakupu              text CHECK (tryb_zakupu IN ('vat_marza','vat_23','vat_wdt','bez_vat','inne')),
  tryb_sprzedazy           text CHECK (tryb_sprzedazy IN ('vat_marza','vat_23','inne')),
  kwota_nabycia_vat_marza  numeric(14,2),  -- wg dokumentów transakcji, nie suma kosztów (p. 17)
  cena_sprzedazy_faktyczna numeric(14,2) CHECK (cena_sprzedazy_faktyczna >= 0),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid REFERENCES users(id)
);

CREATE TABLE car_status_history (
  id             bigserial PRIMARY KEY,
  workspace_id   uuid NOT NULL,
  car_id         uuid NOT NULL REFERENCES cars(id),
  kind           text NOT NULL,
  from_status_id uuid REFERENCES car_statuses(id),
  to_status_id   uuid NOT NULL REFERENCES car_statuses(id),
  changed_by     uuid REFERENCES users(id),
  changed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX car_status_history_car_idx ON car_status_history (car_id, changed_at);

-- Pliki: zdjęcia i skany (przechowywanie: Google Drive — Etap 2/5)
CREATE TABLE files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  car_id        uuid REFERENCES cars(id),
  kind          text NOT NULL CHECK (kind IN ('photo','photo_document','photo_plates','photo_damage','photo_repair','document','invoice','backup','export')),
  storage       text NOT NULL CHECK (storage IN ('gdrive','local')),
  external_id   text,
  url           text,
  thumbnail_url text,
  file_name     text NOT NULL,
  mime_type     text,
  size_bytes    bigint,
  sha256        text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
ALTER TABLE cars ADD CONSTRAINT cars_main_photo_fk FOREIGN KEY (main_photo_file_id) REFERENCES files(id);

-- ----------------------------------------------------------------------------
-- 5. Kontrahenci i dokumenty (logika: Etap 4)
-- ----------------------------------------------------------------------------

CREATE TABLE counterparties (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  name          text NOT NULL,
  nip           text,
  vat_eu        text,
  country_code  char(2),
  address       text,
  is_company    boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id),
  car_id                uuid REFERENCES cars(id),
  doc_type              text NOT NULL CHECK (doc_type IN ('faktura_vat','faktura_vat_marza','faktura_kosztowa',
                          'umowa_kupna_sprzedazy','dokument_zakupu','korekta_faktury','inne')),
  direction             text NOT NULL CHECK (direction IN ('zakup','sprzedaz','koszt','inne')),
  numer_dokumentu       text,
  data_wystawienia      date,
  data_sprzedazy        date,
  counterparty_id       uuid REFERENCES counterparties(id),
  waluta                char(3) NOT NULL DEFAULT 'PLN',
  kwota_netto           numeric(14,2),
  kwota_vat             numeric(14,2),
  kwota_brutto          numeric(14,2),
  koryguje_document_id  uuid REFERENCES documents(id),
  file_id               uuid REFERENCES files(id),
  notatka               text,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  cancelled_at          timestamptz,
  CHECK (doc_type <> 'korekta_faktury' OR koryguje_document_id IS NOT NULL)
);

-- ----------------------------------------------------------------------------
-- 6. Koszty i Kasa (logika: Etap 3)
-- ----------------------------------------------------------------------------

CREATE TABLE costs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id),
  numer            bigint NOT NULL,
  car_id           uuid REFERENCES cars(id),            -- NULL = koszt ogólny firmy
  data             date NOT NULL,
  opis             text NOT NULL,
  category_id      uuid NOT NULL REFERENCES cost_categories(id),
  vat_rate_id      uuid REFERENCES vat_rates(id),
  stawka_vat       numeric(7,4) NOT NULL DEFAULT 0,     -- kopia stawki z chwili zapisu
  kwota_netto      numeric(14,2) NOT NULL,
  kwota_vat        numeric(14,2) NOT NULL,
  kwota_brutto     numeric(14,2) NOT NULL,
  vat_do_odliczenia boolean NOT NULL DEFAULT false,
  sposob_platnosci text NOT NULL CHECK (sposob_platnosci IN ('gotowka','przelew','karta','inne')),
  czy_faktura      boolean NOT NULL DEFAULT false,
  numer_faktury    text,
  document_id      uuid REFERENCES documents(id),
  notatka          text,
  version          int NOT NULL DEFAULT 1,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  cancelled_at     timestamptz,
  UNIQUE (workspace_id, numer),
  CHECK (kwota_brutto = kwota_netto + kwota_vat)
);
CREATE INDEX costs_car_idx ON costs (car_id) WHERE cancelled_at IS NULL;

CREATE TABLE kasa_accounts (
  workspace_id     uuid PRIMARY KEY REFERENCES workspaces(id),
  saldo_poczatkowe numeric(14,2) NOT NULL DEFAULT 0,
  data_poczatkowa  date NOT NULL DEFAULT CURRENT_DATE
);

-- Dziennik kasowy: tylko dopisywanie. Edycja kosztu = operacja korygująca, nie nadpisanie.
CREATE TABLE kasa_operations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id),
  numer            bigint NOT NULL,
  data             date NOT NULL,
  typ              text NOT NULL CHECK (typ IN ('przychod','wydatek','korekta','wplata','wyplata')),
  kwota            numeric(14,2) NOT NULL CHECK (kwota <> 0),  -- ze znakiem: wydatek < 0
  opis             text NOT NULL,
  car_id           uuid REFERENCES cars(id),
  cost_id          uuid REFERENCES costs(id),
  cost_version     int,                       -- wersja kosztu, której dotyczy operacja
  sposob_platnosci text NOT NULL DEFAULT 'gotowka',
  potwierdzona     boolean NOT NULL DEFAULT true,
  idempotency_key  text NOT NULL,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, numer),
  UNIQUE (workspace_id, idempotency_key),
  CHECK (typ <> 'wydatek' OR kwota < 0),
  CHECK (typ NOT IN ('przychod','wplata') OR kwota > 0),
  CHECK (typ <> 'wyplata' OR kwota < 0),
  CHECK ((cost_id IS NULL) = (cost_version IS NULL))
);
-- Jeden koszt w danej wersji → najwyżej jedna operacja kasowa (brak podwójnego obciążenia)
CREATE UNIQUE INDEX kasa_one_op_per_cost_version ON kasa_operations (cost_id, cost_version) WHERE cost_id IS NOT NULL;

-- Saldo po operacji liczone zawsze z dziennika — nie może się "rozjechać" po edycji
CREATE VIEW kasa_ledger WITH (security_invoker = true) AS
SELECT o.*,
       a.saldo_poczatkowe + sum(o.kwota) FILTER (WHERE o.potwierdzona)
         OVER (PARTITION BY o.workspace_id ORDER BY o.data, o.numer
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS saldo_po_operacji
FROM kasa_operations o
JOIN kasa_accounts a ON a.workspace_id = o.workspace_id;

-- ----------------------------------------------------------------------------
-- 7. Podatki — reguły wersjonowane, do weryfikacji przez księgowego (Etap 4)
-- ----------------------------------------------------------------------------

CREATE TABLE tax_rule_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  rule_key      text NOT NULL CHECK (rule_key IN ('vat_marza','vat_standard','akcyza','pit','skladka_zdrowotna')),
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_from    date NOT NULL,
  valid_to      date,
  status        text NOT NULL DEFAULT 'do_weryfikacji' CHECK (status IN ('do_weryfikacji','zweryfikowana','wycofana')),
  verified_by   text,
  verified_at   timestamptz,
  source        text,
  notatka       text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'zweryfikowana' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);

-- ----------------------------------------------------------------------------
-- 8. Aukcje, cenniki, kursy walut, import z aukcji (tylko odczyt) — Etapy 5+
-- ----------------------------------------------------------------------------

CREATE TABLE auctions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  name          text NOT NULL,
  website       text,
  adapter_key   text,      -- NULL = brak adaptera; tylko import ręczny
  api_status    text NOT NULL DEFAULT 'niezweryfikowane'
                 CHECK (api_status IN ('niezweryfikowane','oficjalne_api','brak_api','tylko_recznie')),
  active        boolean NOT NULL DEFAULT true,
  notatka       text,
  UNIQUE (workspace_id, name)
);

CREATE TABLE auction_countries (
  auction_id    uuid NOT NULL REFERENCES auctions(id),
  workspace_id  uuid NOT NULL,
  country_code  char(2) NOT NULL,
  PRIMARY KEY (auction_id, country_code),
  FOREIGN KEY (workspace_id, country_code) REFERENCES countries(workspace_id, code)
);

CREATE TABLE auction_tariffs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id),
  auction_id     uuid NOT NULL REFERENCES auctions(id),
  country_code   char(2) NOT NULL,
  seller_type    text,                        -- np. 'firma', 'leasing', NULL = dowolny
  currency       char(3) NOT NULL,
  vat_rate       numeric(7,4),                -- VAT od usług aukcji
  valid_from     date NOT NULL,
  valid_to       date,
  source         text NOT NULL,               -- skąd pochodzi cennik (plik, umowa, strona)
  is_estimate    boolean NOT NULL DEFAULT true, -- orientacyjny, dopóki nie potwierdzony
  confirmed_by   uuid REFERENCES users(id),
  confirmed_at   timestamptz,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, country_code) REFERENCES countries(workspace_id, code),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

-- Progi cenowe: np. auto 3 000 EUR i 10 000 EUR mogą mieć inną prowizję
CREATE TABLE auction_tariff_tiers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tariff_id    uuid NOT NULL REFERENCES auction_tariffs(id),
  price_from   numeric(14,2) NOT NULL DEFAULT 0,
  price_to     numeric(14,2),                 -- NULL = bez górnej granicy
  fixed_fee    numeric(14,2) NOT NULL DEFAULT 0,
  percent_fee  numeric(7,4) NOT NULL DEFAULT 0,
  min_fee      numeric(14,2),
  max_fee      numeric(14,2),
  CHECK (price_to IS NULL OR price_to > price_from)
);

CREATE TABLE auction_tariff_extra_fees (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tariff_id   uuid NOT NULL REFERENCES auction_tariffs(id),
  name        text NOT NULL,                  -- opłata administracyjna, dokumentacyjna…
  fee_type    text NOT NULL CHECK (fee_type IN ('administracyjna','dokumentacyjna','transportowa','inna')),
  amount      numeric(14,2) NOT NULL,
  vat_rate    numeric(7,4)
);

CREATE TABLE fx_rates (
  currency    char(3) NOT NULL,
  rate_date   date NOT NULL,
  rate_pln    numeric(14,6) NOT NULL CHECK (rate_pln > 0),
  source      text NOT NULL,                  -- np. 'NBP tabela A', 'ręcznie'
  PRIMARY KEY (currency, rate_date, source)
);

CREATE TABLE auction_imports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id),
  auction_id     uuid REFERENCES auctions(id),
  url            text,
  lot_id         text,
  vin            text,
  status         text NOT NULL DEFAULT 'szkic' CHECK (status IN ('szkic','dodany','zaktualizowany','anulowany')),
  source         text NOT NULL DEFAULT 'reczny', -- 'reczny' lub klucz adaptera
  car_id         uuid REFERENCES cars(id),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auction_imports_dup_idx ON auction_imports (workspace_id, vin, lot_id, url);

-- Każda zaimportowana wartość: źródło, data pobrania, potwierdzona czy automatyczna (p. 15.3)
CREATE TABLE auction_import_fields (
  import_id    uuid NOT NULL REFERENCES auction_imports(id),
  field_key    text NOT NULL,
  value        text,                           -- NULL = nieznane (nie zgadujemy)
  source       text NOT NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  is_confirmed boolean NOT NULL DEFAULT false,
  is_automatic boolean NOT NULL DEFAULT false,
  PRIMARY KEY (import_id, field_key)
);

CREATE TABLE auction_price_history (
  id          bigserial PRIMARY KEY,
  import_id   uuid NOT NULL REFERENCES auction_imports(id),
  price       numeric(14,2) NOT NULL,
  currency    char(3) NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  source      text NOT NULL
);

CREATE TABLE purchase_calculations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  import_id     uuid REFERENCES auction_imports(id),
  car_id        uuid REFERENCES cars(id),
  tariff_id     uuid REFERENCES auction_tariffs(id) ON DELETE RESTRICT, -- historyczny cennik nie znika
  inputs        jsonb NOT NULL,
  results       jsonb NOT NULL,
  is_estimate   boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 9. Dziennik zmian i błędów
-- ----------------------------------------------------------------------------

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  workspace_id  uuid,
  user_id       uuid,
  action        text NOT NULL,       -- INSERT / UPDATE / DELETE / LOGIN / LOGOUT / …
  entity        text NOT NULL,
  entity_id     text,
  before        jsonb,
  after         jsonb,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_ws_at_idx ON audit_log (workspace_id, at DESC);

CREATE TABLE error_log (
  id            bigserial PRIMARY KEY,
  workspace_id  uuid,
  user_id       uuid,
  method        text,
  path          text,
  message       text NOT NULL,
  stack         text,
  at            timestamptz NOT NULL DEFAULT now()
);

-- Uwierzytelnianie odbywa się przed ustaleniem przestrzeni (brak kontekstu RLS),
-- dlatego członkostwo sprawdzają dwie wąskie funkcje z prawami właściciela.
CREATE FUNCTION auth_member_workspace(p_user uuid, p_ws_code text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.workspace_id
  FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id AND w.active
  WHERE m.user_id = p_user AND m.active AND (p_ws_code IS NULL OR w.code = p_ws_code)
  ORDER BY w.created_at LIMIT 1
$$;

CREATE FUNCTION auth_find_session(p_token_hash bytea)
RETURNS TABLE (session_id uuid, user_id uuid, email text, full_name text, workspace_id uuid,
               workspace_code text, workspace_name text, role_code text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, u.id, u.email, u.full_name, w.id, w.code, w.name, m.role_code, s.expires_at
  FROM sessions s
  JOIN users u ON u.id = s.user_id AND u.is_active
  JOIN workspaces w ON w.id = s.workspace_id AND w.active
  JOIN workspace_members m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id AND m.active
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
$$;

-- Zdarzenia logowania zapisywane przez rolę aplikacji, która nie ma prawa INSERT do audit_log
CREATE FUNCTION app_log_auth_event(p_ws uuid, p_user uuid, p_action text, p_details jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_action NOT IN ('LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'PASSWORD_CHANGED') THEN
    RAISE EXCEPTION 'Niedozwolone zdarzenie: %', p_action;
  END IF;
  INSERT INTO audit_log (workspace_id, user_id, action, entity, entity_id, after)
  VALUES (p_ws, p_user, p_action, 'auth', p_user::text, p_details);
END $$;

-- ----------------------------------------------------------------------------
-- 10. Triggery
-- ----------------------------------------------------------------------------

-- Audyt: kto, kiedy, co zmienił. Nigdy nie zapisujemy hashy haseł ani tokenów.
CREATE FUNCTION trg_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_ws     uuid;
  v_id     text;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_before := to_jsonb(OLD) - 'password_hash' - 'token_hash'; END IF;
  IF TG_OP <> 'DELETE' THEN v_after  := to_jsonb(NEW) - 'password_hash' - 'token_hash'; END IF;
  v_ws := coalesce((v_after ->> 'workspace_id')::uuid, (v_before ->> 'workspace_id')::uuid, app_workspace());
  v_id := coalesce(v_after ->> 'id', v_before ->> 'id', v_after ->> 'car_id', v_before ->> 'car_id');
  IF TG_OP = 'UPDATE' AND v_before = v_after THEN RETURN NULL; END IF;
  INSERT INTO audit_log (workspace_id, user_id, action, entity, entity_id, before, after)
  VALUES (v_ws, app_user(), TG_OP, TG_TABLE_NAME, v_id, v_before, v_after);
  RETURN NULL;
END $$;

-- Sprawdza, czy status należy do tej samej przestrzeni i ma właściwy rodzaj
CREATE FUNCTION assert_status(p_ws uuid, p_status uuid, p_kind text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM car_statuses
                 WHERE id = p_status AND workspace_id = p_ws AND kind = p_kind) THEN
    RAISE EXCEPTION 'Nieprawidłowy status (%): %', p_kind, p_status USING ERRCODE = '23514';
  END IF;
END $$;

CREATE FUNCTION trg_cars_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.numer      := app_next_number(NEW.workspace_id, 'car');
    NEW.version    := 1;
    NEW.created_at := now();
    NEW.created_by := coalesce(NEW.created_by, app_user());
  ELSE
    IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.numer <> OLD.numer
       OR NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'Numer auta i identyfikatory są niezmienne' USING ERRCODE = '23514';
    END IF;
    -- Uprawnienia na poziomie pól (gdy działa użytkownik aplikacji; skrypty administracyjne bez kontekstu)
    IF app_user() IS NOT NULL THEN
      IF NOT app_has_perm('cars.edit') AND
         (to_jsonb(NEW) - 'logistic_status_id' - 'sales_status_id' - 'settlement_status_id' - 'version' - 'updated_at')
         <> (to_jsonb(OLD) - 'logistic_status_id' - 'sales_status_id' - 'settlement_status_id' - 'version' - 'updated_at') THEN
        RAISE EXCEPTION 'Brak uprawnień do edycji danych samochodu' USING ERRCODE = '42501';
      END IF;
      IF NEW.settlement_status_id <> OLD.settlement_status_id AND NOT app_has_perm('cars.settle') THEN
        RAISE EXCEPTION 'Brak uprawnień do rozliczania samochodów' USING ERRCODE = '42501';
      END IF;
      IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NOT app_has_perm('cars.delete') THEN
        RAISE EXCEPTION 'Brak uprawnień do archiwizacji samochodów' USING ERRCODE = '42501';
      END IF;
    END IF;
    NEW.version    := OLD.version + 1;
    NEW.updated_at := now();
  END IF;
  NEW.vin := nullif(upper(trim(NEW.vin)), '');
  PERFORM assert_status(NEW.workspace_id, NEW.logistic_status_id, 'logistic');
  PERFORM assert_status(NEW.workspace_id, NEW.sales_status_id, 'sales');
  PERFORM assert_status(NEW.workspace_id, NEW.settlement_status_id, 'settlement');
  RETURN NEW;
END $$;
CREATE TRIGGER cars_before BEFORE INSERT OR UPDATE ON cars
  FOR EACH ROW EXECUTE FUNCTION trg_cars_before();

-- Historia zmian statusów z datą, godziną i użytkownikiem
CREATE FUNCTION trg_cars_status_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.logistic_status_id <> OLD.logistic_status_id THEN
    INSERT INTO car_status_history (workspace_id, car_id, kind, from_status_id, to_status_id, changed_by)
    VALUES (NEW.workspace_id, NEW.id, 'logistic',
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.logistic_status_id END, NEW.logistic_status_id, app_user());
  END IF;
  IF TG_OP = 'INSERT' OR NEW.sales_status_id <> OLD.sales_status_id THEN
    INSERT INTO car_status_history (workspace_id, car_id, kind, from_status_id, to_status_id, changed_by)
    VALUES (NEW.workspace_id, NEW.id, 'sales',
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.sales_status_id END, NEW.sales_status_id, app_user());
  END IF;
  IF TG_OP = 'INSERT' OR NEW.settlement_status_id <> OLD.settlement_status_id THEN
    INSERT INTO car_status_history (workspace_id, car_id, kind, from_status_id, to_status_id, changed_by)
    VALUES (NEW.workspace_id, NEW.id, 'settlement',
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.settlement_status_id END, NEW.settlement_status_id, app_user());
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER cars_status_history AFTER INSERT OR UPDATE ON cars
  FOR EACH ROW EXECUTE FUNCTION trg_cars_status_history();

-- Zmiana statusu w jednym miejscu. Funkcja działa z prawami właściciela, bo rola z ograniczonym
-- widokiem (np. Serwis) po zmianie statusu przestaje widzieć auto, a RLS sprawdza też nowy wiersz.
-- Uprawnienia sprawdzane są tu jawnie: członkostwo, widoczność auta, cars.status/edit, cars.settle.
CREATE FUNCTION app_change_car_status(p_car uuid, p_kind text, p_status uuid, p_version int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_car cars%ROWTYPE;
  v_new int;
BEGIN
  IF app_user() IS NULL OR app_role() IS NULL THEN
    RAISE EXCEPTION 'Brak aktywnej sesji' USING ERRCODE = '42501';
  END IF;
  IF NOT (app_has_perm('cars.status') OR app_has_perm('cars.edit')) THEN
    RAISE EXCEPTION 'Brak uprawnień do zmiany statusu' USING ERRCODE = '42501';
  END IF;
  IF p_kind = 'settlement' AND NOT app_has_perm('cars.settle') THEN
    RAISE EXCEPTION 'Brak uprawnień do rozliczania samochodów' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_car FROM cars
  WHERE id = p_car AND workspace_id = app_workspace() AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR NOT app_has_perm('cars.view') OR NOT app_car_visible(v_car.logistic_status_id) THEN
    RAISE EXCEPTION 'Nie znaleziono samochodu' USING ERRCODE = 'P0002';
  END IF;
  IF v_car.version <> p_version THEN
    RAISE EXCEPTION 'Nieaktualna wersja danych' USING ERRCODE = 'OA409';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM car_statuses WHERE id = p_status AND workspace_id = app_workspace()
                 AND kind = p_kind AND active) THEN
    RAISE EXCEPTION 'Nieprawidłowy status' USING ERRCODE = '23514';
  END IF;
  UPDATE cars SET
    logistic_status_id   = CASE WHEN p_kind = 'logistic'   THEN p_status ELSE logistic_status_id END,
    sales_status_id      = CASE WHEN p_kind = 'sales'      THEN p_status ELSE sales_status_id END,
    settlement_status_id = CASE WHEN p_kind = 'settlement' THEN p_status ELSE settlement_status_id END
  WHERE id = p_car
  RETURNING version INTO v_new;
  RETURN v_new;
END $$;

CREATE FUNCTION trg_numbered_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.numer := app_next_number(NEW.workspace_id, TG_ARGV[0]);
  RETURN NEW;
END $$;
CREATE TRIGGER costs_numer BEFORE INSERT ON costs
  FOR EACH ROW EXECUTE FUNCTION trg_numbered_before_insert('cost');
CREATE TRIGGER kasa_numer BEFORE INSERT ON kasa_operations
  FOR EACH ROW EXECUTE FUNCTION trg_numbered_before_insert('kasa');

-- Dziennik kasowy jest niezmienny (tylko dopisywanie)
CREATE FUNCTION trg_kasa_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Operacji kasowych nie można zmieniać ani usuwać — dodaj korektę' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER kasa_immutable BEFORE UPDATE OR DELETE ON kasa_operations
  FOR EACH ROW EXECUTE FUNCTION trg_kasa_immutable();

-- Cennik użyty w kalkulacji nie może być zmieniony (można dodać nową wersję)
CREATE FUNCTION trg_tariff_protect() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tariff uuid;
BEGIN
  v_tariff := CASE WHEN TG_TABLE_NAME = 'auction_tariffs' THEN OLD.id ELSE OLD.tariff_id END;
  IF EXISTS (SELECT 1 FROM purchase_calculations WHERE tariff_id = v_tariff) THEN
    IF TG_TABLE_NAME = 'auction_tariffs' AND TG_OP = 'UPDATE'
       AND (to_jsonb(NEW) - 'valid_to' - 'is_estimate' - 'confirmed_by' - 'confirmed_at')
         = (to_jsonb(OLD) - 'valid_to' - 'is_estimate' - 'confirmed_by' - 'confirmed_at') THEN
      RETURN NEW; -- wolno zamknąć okres obowiązywania i potwierdzić
    END IF;
    RAISE EXCEPTION 'Cennik był użyty w kalkulacjach — utwórz nową wersję' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER auction_tariffs_protect BEFORE UPDATE OR DELETE ON auction_tariffs
  FOR EACH ROW EXECUTE FUNCTION trg_tariff_protect();
CREATE TRIGGER auction_tariff_tiers_protect BEFORE UPDATE OR DELETE ON auction_tariff_tiers
  FOR EACH ROW EXECUTE FUNCTION trg_tariff_protect();
CREATE TRIGGER auction_tariff_fees_protect BEFORE UPDATE OR DELETE ON auction_tariff_extra_fees
  FOR EACH ROW EXECUTE FUNCTION trg_tariff_protect();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cars','car_finance','costs','kasa_operations','documents','counterparties',
                           'car_statuses','countries','vat_rates','cost_categories','auctions','auction_tariffs',
                           'tax_rule_versions','workspace_members','role_permissions','role_status_scope',
                           'invitations','kasa_accounts','files','users']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION trg_audit()', t, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 11. Row-Level Security
-- ----------------------------------------------------------------------------

CREATE FUNCTION app_is_member() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT app_role() IS NOT NULL $$;

ALTER TABLE cars ENABLE ROW LEVEL SECURITY;
CREATE POLICY cars_select ON cars FOR SELECT
  USING (workspace_id = app_workspace() AND app_has_perm('cars.view') AND app_car_visible(logistic_status_id));
CREATE POLICY cars_insert ON cars FOR INSERT
  WITH CHECK (workspace_id = app_workspace() AND app_has_perm('cars.create'));
CREATE POLICY cars_update ON cars FOR UPDATE
  USING (workspace_id = app_workspace() AND (app_has_perm('cars.edit') OR app_has_perm('cars.status'))
         AND app_car_visible(logistic_status_id))
  WITH CHECK (workspace_id = app_workspace() AND (app_has_perm('cars.edit') OR app_has_perm('cars.status')));

ALTER TABLE car_finance ENABLE ROW LEVEL SECURITY;
CREATE POLICY car_finance_select ON car_finance FOR SELECT
  USING (workspace_id = app_workspace() AND app_has_perm('cars.finance.view'));
CREATE POLICY car_finance_insert ON car_finance FOR INSERT
  WITH CHECK (workspace_id = app_workspace() AND app_has_perm('cars.finance.edit'));
CREATE POLICY car_finance_update ON car_finance FOR UPDATE
  USING (workspace_id = app_workspace() AND app_has_perm('cars.finance.edit'))
  WITH CHECK (workspace_id = app_workspace() AND app_has_perm('cars.finance.edit'));

ALTER TABLE car_status_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY car_status_history_select ON car_status_history FOR SELECT
  USING (workspace_id = app_workspace() AND app_has_perm('cars.view')
         AND EXISTS (SELECT 1 FROM cars c WHERE c.id = car_id));  -- tylko auta widoczne dla roli

ALTER TABLE costs ENABLE ROW LEVEL SECURITY;
CREATE POLICY costs_select ON costs FOR SELECT
  USING (workspace_id = app_workspace() AND app_has_perm('costs.view'));
CREATE POLICY costs_write ON costs FOR INSERT
  WITH CHECK (workspace_id = app_workspace() AND app_has_perm('costs.edit'));
CREATE POLICY costs_update ON costs FOR UPDATE
  USING (workspace_id = app_workspace() AND app_has_perm('costs.edit'))
  WITH CHECK (workspace_id = app_workspace() AND app_has_perm('costs.edit'));

ALTER TABLE kasa_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY kasa_select ON kasa_operations FOR SELECT
  USING (workspace_id = app_workspace() AND app_has_perm('kasa.view'));
CREATE POLICY kasa_insert ON kasa_operations FOR INSERT
  WITH CHECK (workspace_id = app_workspace() AND (app_has_perm('kasa.edit') OR app_has_perm('costs.edit')));

ALTER TABLE kasa_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY kasa_accounts_select ON kasa_accounts FOR SELECT
  USING (workspace_id = app_workspace() AND app_has_perm('kasa.view'));
CREATE POLICY kasa_accounts_update ON kasa_accounts FOR UPDATE
  USING (workspace_id = app_workspace() AND app_has_perm('kasa.edit'));

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY documents_select ON documents FOR SELECT
  USING (workspace_id = app_workspace() AND app_has_perm('documents.view'));
CREATE POLICY documents_insert ON documents FOR INSERT
  WITH CHECK (workspace_id = app_workspace() AND app_has_perm('documents.edit'));
CREATE POLICY documents_update ON documents FOR UPDATE
  USING (workspace_id = app_workspace() AND app_has_perm('documents.edit'));

ALTER TABLE counterparties ENABLE ROW LEVEL SECURITY;
CREATE POLICY counterparties_all ON counterparties
  USING (workspace_id = app_workspace() AND app_has_perm('documents.view'))
  WITH CHECK (workspace_id = app_workspace() AND app_has_perm('documents.edit'));

ALTER TABLE files ENABLE ROW LEVEL SECURITY;
CREATE POLICY files_select ON files FOR SELECT
  USING (workspace_id = app_workspace() AND app_has_perm('cars.view')
         AND (car_id IS NULL OR EXISTS (SELECT 1 FROM cars c WHERE c.id = car_id)));
CREATE POLICY files_insert ON files FOR INSERT
  WITH CHECK (workspace_id = app_workspace() AND (app_has_perm('cars.edit') OR app_has_perm('cars.status')));
CREATE POLICY files_update ON files FOR UPDATE
  USING (workspace_id = app_workspace() AND app_has_perm('cars.edit'));

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON audit_log FOR SELECT
  USING (workspace_id = app_workspace() AND app_has_perm('audit.view'));

ALTER TABLE error_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY error_select ON error_log FOR SELECT
  USING (workspace_id = app_workspace() AND app_has_perm('audit.view'));
CREATE POLICY error_insert ON error_log FOR INSERT WITH CHECK (true);

-- Słowniki: odczyt dla członków przestrzeni, zapis dla settings.manage
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['car_statuses','countries','vat_rates','cost_categories','auctions',
                           'auction_tariffs','tax_rule_versions','auction_imports','purchase_calculations']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I_select ON %I FOR SELECT USING (workspace_id = app_workspace() AND app_is_member())', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['car_statuses','countries','vat_rates','cost_categories','auctions',
                           'auction_tariffs','tax_rule_versions']
  LOOP
    EXECUTE format('CREATE POLICY %I_insert ON %I FOR INSERT WITH CHECK (workspace_id = app_workspace() AND app_has_perm(''settings.manage''))', t, t);
    EXECUTE format('CREATE POLICY %I_update ON %I FOR UPDATE USING (workspace_id = app_workspace() AND app_has_perm(''settings.manage''))', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['auction_imports','purchase_calculations']
  LOOP
    EXECUTE format('CREATE POLICY %I_insert ON %I FOR INSERT WITH CHECK (workspace_id = app_workspace() AND app_has_perm(''import.auction''))', t, t);
    EXECUTE format('CREATE POLICY %I_update ON %I FOR UPDATE USING (workspace_id = app_workspace() AND app_has_perm(''import.auction''))', t, t);
  END LOOP;
END $$;

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY role_permissions_select ON role_permissions FOR SELECT
  USING (workspace_id = app_workspace() AND app_is_member());
CREATE POLICY role_permissions_write ON role_permissions
  USING (workspace_id = app_workspace() AND app_has_perm('users.manage'))
  WITH CHECK (workspace_id = app_workspace() AND app_has_perm('users.manage'));

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY roles_select ON roles FOR SELECT
  USING (workspace_id = app_workspace() AND app_is_member());

ALTER TABLE role_status_scope ENABLE ROW LEVEL SECURITY;
CREATE POLICY role_status_scope_select ON role_status_scope FOR SELECT
  USING (workspace_id = app_workspace() AND app_is_member());
CREATE POLICY role_status_scope_write ON role_status_scope
  USING (workspace_id = app_workspace() AND app_has_perm('users.manage'))
  WITH CHECK (workspace_id = app_workspace() AND app_has_perm('users.manage'));

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY members_select ON workspace_members FOR SELECT
  USING (workspace_id = app_workspace() AND (user_id = app_user() OR app_has_perm('users.manage')));
CREATE POLICY members_write ON workspace_members FOR INSERT
  WITH CHECK (workspace_id = app_workspace() AND app_has_perm('users.manage'));
CREATE POLICY members_update ON workspace_members FOR UPDATE
  USING (workspace_id = app_workspace() AND app_has_perm('users.manage'));

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitations_all ON invitations
  USING (workspace_id = app_workspace() AND app_has_perm('users.manage'))
  WITH CHECK (workspace_id = app_workspace() AND app_has_perm('users.manage'));

-- users i sessions: dostęp przez warstwę uwierzytelniania (logowanie odbywa się
-- przed ustaleniem przestrzeni). Hasła są hashowane (scrypt), tokeny — SHA-256.

-- ----------------------------------------------------------------------------
-- 12. Inicjalizacja przestrzeni roboczej (role, uprawnienia, statusy, słowniki)
-- ----------------------------------------------------------------------------

CREATE FUNCTION init_workspace(p_ws uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  all_perms text[] := ARRAY[
    'dashboard.view','cars.view','cars.create','cars.edit','cars.status','cars.settle','cars.delete',
    'cars.finance.view','cars.finance.edit','costs.view','costs.edit','kasa.view','kasa.edit',
    'finance.view','reports.view','documents.view','documents.edit','import.auction',
    'users.manage','settings.manage','audit.view','backup.manage'];
  r record;
BEGIN
  INSERT INTO roles (workspace_id, code, name, is_system) VALUES
    (p_ws,'owner','Właściciel',true), (p_ws,'administrator','Administrator',true),
    (p_ws,'manager','Manager',true), (p_ws,'sprzedawca','Sprzedawca',true),
    (p_ws,'serwis','Serwis',true), (p_ws,'lakiernia','Lakiernia',true),
    (p_ws,'ksiegowosc','Księgowość',true), (p_ws,'viewer','Podgląd',true);

  FOR r IN SELECT * FROM (VALUES
      ('owner',        all_perms),
      ('administrator',all_perms),
      ('manager',      ARRAY['dashboard.view','cars.view','cars.create','cars.edit','cars.status','cars.settle',
                             'cars.finance.view','cars.finance.edit','costs.view','costs.edit','kasa.view','kasa.edit',
                             'finance.view','reports.view','documents.view','documents.edit','import.auction']),
      ('sprzedawca',   ARRAY['dashboard.view','cars.view','cars.edit','cars.status','documents.view']),
      ('serwis',       ARRAY['cars.view','cars.status']),
      ('lakiernia',    ARRAY['cars.view','cars.status']),
      ('ksiegowosc',   ARRAY['dashboard.view','cars.view','cars.finance.view','costs.view','costs.edit','kasa.view',
                             'finance.view','reports.view','documents.view','documents.edit']),
      ('viewer',       ARRAY['dashboard.view','cars.view'])
    ) AS t(role_code, perms)
  LOOP
    INSERT INTO role_permissions (workspace_id, role_code, permission)
    SELECT p_ws, r.role_code, unnest(r.perms);
  END LOOP;

  INSERT INTO car_statuses (workspace_id, kind, system_code, name, color, sort_order, is_closed, is_default) VALUES
    (p_ws,'logistic','w_drodze','W drodze','#EAB308',10,false,true),
    (p_ws,'logistic','na_placu','Na placu','#16A34A',20,false,false),
    (p_ws,'logistic','serwis','Serwis','#7C3AED',30,false,false),
    (p_ws,'logistic','lakiernia','Lakiernia','#C026D3',40,false,false),
    (p_ws,'logistic','problem','Problem / Wstrzymane','#DC2626',50,false,false),
    (p_ws,'sales','przygotowanie','Przygotowanie','#64748B',10,false,true),
    (p_ws,'sales','w_sprzedazy','W sprzedaży','#0891B2',20,false,false),
    (p_ws,'sales','zarezerwowany','Zarezerwowany','#F97316',30,false,false),
    (p_ws,'sales','sprzedany','Sprzedany','#0F766E',40,false,false),
    (p_ws,'settlement','otwarte','Otwarte','#94A3B8',10,false,true),
    (p_ws,'settlement','rozliczone','Rozliczone','#2563EB',20,true,false);

  INSERT INTO role_status_scope (workspace_id, role_code, status_id)
  SELECT p_ws, 'serwis', id FROM car_statuses WHERE workspace_id = p_ws AND kind='logistic' AND system_code='serwis'
  UNION ALL
  SELECT p_ws, 'lakiernia', id FROM car_statuses WHERE workspace_id = p_ws AND kind='logistic' AND system_code='lakiernia';

  INSERT INTO countries (workspace_id, code, name, currency, sort_order) VALUES
    (p_ws,'PL','Polska','PLN',10), (p_ws,'DE','Niemcy','EUR',20), (p_ws,'NL','Holandia','EUR',30),
    (p_ws,'BE','Belgia','EUR',40), (p_ws,'FR','Francja','EUR',50), (p_ws,'ES','Hiszpania','EUR',60),
    (p_ws,'IT','Włochy','EUR',70), (p_ws,'AT','Austria','EUR',80);

  INSERT INTO vat_rates (workspace_id, label, rate, sort_order) VALUES
    (p_ws,'0%',0,10), (p_ws,'23%',0.23,20);

  INSERT INTO cost_categories (workspace_id, system_code, name, sort_order) VALUES
    (p_ws,'transport','Transport',10), (p_ws,'serwis','Serwis',20), (p_ws,'lakiernia','Lakiernia',30),
    (p_ws,'czesci','Części',40), (p_ws,'aukcja','Aukcja',50), (p_ws,'oplaty','Opłaty',60),
    (p_ws,'akcyza','Akcyza',70), (p_ws,'inne','Inne',80);

  INSERT INTO kasa_accounts (workspace_id) VALUES (p_ws);

  -- Reguły podatkowe: wyłącznie szkice do weryfikacji przez księgowego.
  -- Stawki akcyzy, PIT i składki zdrowotnej NIE są wpisywane — uzupełnia je księgowy.
  INSERT INTO tax_rule_versions (workspace_id, rule_key, params, valid_from, status, notatka) VALUES
    (p_ws,'vat_marza','{"stawka":"0.23","wzor":"VAT = MAX(0, marża brutto × 23/123)"}', DATE '2000-01-01','do_weryfikacji',
     'Wzór z założeń projektu — wymaga potwierdzenia przez księgowego przed użyciem w rozliczeniach.'),
    (p_ws,'akcyza','{}', DATE '2000-01-01','do_weryfikacji','Stawki do uzupełnienia przez księgowego.'),
    (p_ws,'pit','{}', DATE '2000-01-01','do_weryfikacji','Do uzupełnienia przez księgowego.'),
    (p_ws,'skladka_zdrowotna','{}', DATE '2000-01-01','do_weryfikacji','Do uzupełnienia przez księgowego.');

  -- Potencjalne integracje — bez potwierdzenia istnienia oficjalnego API i bez cenników
  INSERT INTO auctions (workspace_id, name, api_status, notatka) VALUES
    (p_ws,'OPENLANE','niezweryfikowane','Potencjalna integracja; API niepotwierdzone.'),
    (p_ws,'BCA','niezweryfikowane','Potencjalna integracja; API niepotwierdzone.'),
    (p_ws,'Autorola','niezweryfikowane','Potencjalna integracja; API niepotwierdzone.'),
    (p_ws,'AUTO1','niezweryfikowane','Potencjalna integracja; API niepotwierdzone.');
END $$;
