-- =============================================================================
-- OpenAuto CRM — migracja 0006: Etap 3 — Koszty i Kasa
--
-- Najważniejsze gwarancje (w bazie, nie tylko w programie):
--   * koszt opłacony gotówką ZAWSZE ma odpowiadającą operację w kasie (trigger),
--   * zmiana kwoty / sposobu płatności / anulowanie → automatyczna korekta różnicy,
--   * nigdy podwójne obciążenie: kwota w kasie = suma operacji danego kosztu (samonaprawiające),
--     a jedna wersja kosztu ma najwyżej jedną operację (unikalny indeks z 0001),
--   * dziennik kasy tylko do dopisywania (trigger z 0001), ręcznie nie da się dopisać
--     operacji „udającej” koszt ani zwykłego wydatku z pominięciem Kosztów.
--
-- Zgodne wstecz: poprzednia wersja kodu nie zapisuje kosztów ani operacji kasowych.
-- =============================================================================

-- 1. Kwoty kosztu: dodatnie, VAT nieujemny (brutto = netto + VAT — CHECK z 0001)
ALTER TABLE costs ADD CONSTRAINT costs_kwoty_dodatnie
  CHECK (kwota_brutto > 0 AND kwota_netto >= 0 AND kwota_vat >= 0) NOT VALID;
ALTER TABLE costs VALIDATE CONSTRAINT costs_kwoty_dodatnie;

-- 2. Integralność kosztu: numer/wersja/autor nadaje baza, odwołania tylko w obrębie tej samej przestrzeni,
--    anulowany koszt jest zamknięty.
CREATE FUNCTION trg_costs_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.version      := 1;
    NEW.created_at   := now();
    NEW.updated_at   := now();
    NEW.created_by   := coalesce(app_user(), NEW.created_by);
    NEW.cancelled_at := NULL;
    IF NOT EXISTS (SELECT 1 FROM cost_categories
                   WHERE id = NEW.category_id AND workspace_id = NEW.workspace_id AND active) THEN
      RAISE EXCEPTION 'Nieprawidłowa kategoria kosztu' USING ERRCODE = '23503';
    END IF;
  ELSE
    IF OLD.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'Anulowanego kosztu nie można zmieniać' USING ERRCODE = '23514';
    END IF;
    IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.numer <> OLD.numer
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at
       OR NEW.client_key IS DISTINCT FROM OLD.client_key THEN
      RAISE EXCEPTION 'Tych pól kosztu nie można zmieniać' USING ERRCODE = '23514';
    END IF;
    NEW.version    := OLD.version + 1;
    NEW.updated_at := now();
    IF NEW.category_id <> OLD.category_id AND NOT EXISTS (
         SELECT 1 FROM cost_categories WHERE id = NEW.category_id AND workspace_id = NEW.workspace_id AND active) THEN
      RAISE EXCEPTION 'Nieprawidłowa kategoria kosztu' USING ERRCODE = '23503';
    END IF;
  END IF;

  IF NEW.car_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.car_id IS DISTINCT FROM OLD.car_id)
     AND NOT EXISTS (SELECT 1 FROM cars WHERE id = NEW.car_id AND workspace_id = NEW.workspace_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Nie znaleziono samochodu' USING ERRCODE = '23503';
  END IF;
  IF NEW.document_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'Nie znaleziono dokumentu' USING ERRCODE = '23503';
  END IF;
  -- stawka VAT: kopia z chwili wyboru stawki (późniejsza zmiana słownika nie zmienia starych kosztów)
  IF NEW.vat_rate_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.vat_rate_id IS DISTINCT FROM OLD.vat_rate_id) THEN
    SELECT rate INTO NEW.stawka_vat FROM vat_rates WHERE id = NEW.vat_rate_id AND workspace_id = NEW.workspace_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Nieprawidłowa stawka VAT' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER costs_before BEFORE INSERT OR UPDATE ON costs
  FOR EACH ROW EXECUTE FUNCTION trg_costs_before();

-- 3. Automatyczne operacje kasowe dla kosztów płatnych gotówką.
--    Docelowy wpływ na kasę: −brutto (gotówka, nieanulowany) albo 0. Zapisujemy RÓŻNICĘ między
--    docelowym wpływem a sumą dotychczasowych operacji tego kosztu — dzięki temu ponowne
--    przetworzenie nigdy nie obciąży kasy drugi raz.
CREATE FUNCTION app_cost_cash_effect(p_cancelled timestamptz, p_sposob text, p_brutto numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_cancelled IS NULL AND p_sposob = 'gotowka' THEN -p_brutto ELSE 0 END
$$;

CREATE FUNCTION trg_costs_kasa() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_booked numeric;
  v_has_ops boolean;
  v_delta  numeric;
  v_typ    text;
BEGIN
  SELECT coalesce(sum(kwota), 0), count(*) > 0 INTO v_booked, v_has_ops
  FROM kasa_operations WHERE cost_id = NEW.id;
  v_delta := app_cost_cash_effect(NEW.cancelled_at, NEW.sposob_platnosci, NEW.kwota_brutto) - v_booked;
  IF v_delta = 0 THEN
    RETURN NULL;
  END IF;
  v_typ := CASE WHEN NOT v_has_ops AND v_delta < 0 THEN 'wydatek' ELSE 'korekta' END;
  INSERT INTO kasa_operations
    (workspace_id, data, typ, kwota, opis, car_id, cost_id, cost_version, sposob_platnosci, idempotency_key, created_by)
  VALUES (
    NEW.workspace_id,
    CASE WHEN v_typ = 'wydatek' THEN NEW.data ELSE (now() AT TIME ZONE 'Europe/Warsaw')::date END,
    v_typ,
    v_delta,
    CASE
      WHEN v_typ = 'wydatek' THEN 'Koszt nr ' || NEW.numer || ': ' || NEW.opis
      WHEN NEW.cancelled_at IS NOT NULL THEN 'Korekta — anulowanie kosztu nr ' || NEW.numer || ': ' || NEW.opis
      ELSE 'Korekta — zmiana kosztu nr ' || NEW.numer || ': ' || NEW.opis
    END,
    NEW.car_id, NEW.id, NEW.version, 'gotowka',
    'cost:' || NEW.id || ':v' || NEW.version,
    coalesce(app_user(), NEW.created_by)
  );
  RETURN NULL;
END $$;
CREATE TRIGGER costs_kasa AFTER INSERT OR UPDATE ON costs
  FOR EACH ROW EXECUTE FUNCTION trg_costs_kasa();

-- 4. Ręczne operacje kasowe: tylko z uprawnieniem kasa.edit, bez powiązania z kosztem
--    i bez zwykłego „wydatku” (wydatki gotówkowe wprowadza się w Kosztach — mają kategorię i trafiają do auta).
DROP POLICY kasa_insert ON kasa_operations;
CREATE POLICY kasa_insert ON kasa_operations FOR INSERT
  WITH CHECK (workspace_id = app_workspace() AND app_has_perm('kasa.edit')
              AND cost_id IS NULL AND typ IN ('przychod', 'wplata', 'wyplata', 'korekta'));

CREATE FUNCTION trg_kasa_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.created_by := coalesce(app_user(), NEW.created_by);
  NEW.created_at := now();
  IF NEW.car_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM cars WHERE id = NEW.car_id AND workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'Nie znaleziono samochodu' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kasa_before_insert BEFORE INSERT ON kasa_operations
  FOR EACH ROW EXECUTE FUNCTION trg_kasa_before_insert();

-- 5. Saldo początkowe ustawia się przed pierwszą operacją; później tylko korektą (ślad w dzienniku).
CREATE FUNCTION trg_kasa_accounts_protect() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.workspace_id <> OLD.workspace_id THEN
    RAISE EXCEPTION 'Nie można zmienić przestrzeni kasy' USING ERRCODE = '23514';
  END IF;
  IF (NEW.saldo_poczatkowe, NEW.data_poczatkowa) IS DISTINCT FROM (OLD.saldo_poczatkowe, OLD.data_poczatkowa)
     AND EXISTS (SELECT 1 FROM kasa_operations WHERE workspace_id = OLD.workspace_id) THEN
    RAISE EXCEPTION 'Saldo początkowe można ustawić tylko przed pierwszą operacją — później dodaj korektę'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kasa_accounts_protect BEFORE UPDATE ON kasa_accounts
  FOR EACH ROW EXECUTE FUNCTION trg_kasa_accounts_protect();

-- 6. Ochrona przed podwójnym zapisem tego samego formularza (słaby internet, podwójne kliknięcie):
--    klient wysyła losowy klucz; ten sam klucz = ten sam koszt, a więc i jedna operacja w kasie.
ALTER TABLE costs ADD COLUMN client_key text CHECK (client_key IS NULL OR length(client_key) BETWEEN 8 AND 100);
CREATE UNIQUE INDEX costs_client_key_uq ON costs (workspace_id, client_key) WHERE client_key IS NOT NULL;

CREATE INDEX costs_ws_data_idx ON costs (workspace_id, data DESC, numer DESC);
CREATE INDEX kasa_ws_data_idx ON kasa_operations (workspace_id, data, numer);
CREATE INDEX kasa_cost_idx ON kasa_operations (cost_id) WHERE cost_id IS NOT NULL;
