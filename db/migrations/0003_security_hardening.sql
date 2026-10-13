-- =============================================================================
-- OpenAuto CRM — migracja 0003: wzmocnienia bezpieczeństwa po przeglądzie przed uruchomieniem
-- =============================================================================

-- 1. Funkcje SECURITY DEFINER: tabele tymczasowe sesji (pg_temp) przeszukiwane na końcu,
--    aby nie dało się podstawić własnej tabeli o tej samej nazwie.
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', f.sig);
  END LOOP;
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;

-- 2. Wymuszona zmiana hasła: hasła tymczasowe (pierwszy właściciel, konta zakładane przez właściciela)
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

-- 3. Sesja wygasa najpóźniej 7 dni po zalogowaniu (niezależnie od aktywności);
--    funkcja zwraca też informację o haśle tymczasowym
DROP FUNCTION auth_find_session(bytea);
CREATE FUNCTION auth_find_session(p_token_hash bytea)
RETURNS TABLE (session_id uuid, user_id uuid, email text, full_name text, workspace_id uuid,
               workspace_code text, workspace_name text, role_code text, expires_at timestamptz,
               must_change_password boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, u.id, u.email, u.full_name, w.id, w.code, w.name, m.role_code, s.expires_at, u.must_change_password
  FROM sessions s
  JOIN users u ON u.id = s.user_id AND u.is_active
  JOIN workspaces w ON w.id = s.workspace_id AND w.active
  JOIN workspace_members m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id AND m.active
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
    AND s.created_at > now() - interval '7 days'
$$;

-- 4. Role tylko ze zmianą statusu (Serwis, Lakiernia) zmieniają wyłącznie status logistyczny —
--    nie mogą oznaczyć auta jako sprzedanego ani zarezerwowanego.
CREATE OR REPLACE FUNCTION app_change_car_status(p_car uuid, p_kind text, p_status uuid, p_version int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
  IF p_kind = 'sales' AND NOT app_has_perm('cars.edit') THEN
    RAISE EXCEPTION 'Brak uprawnień do zmiany statusu sprzedaży' USING ERRCODE = '42501';
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

-- 4b. To samo w triggerze (bezpośredni UPDATE): bez cars.edit wolno zmienić tylko status logistyczny
CREATE OR REPLACE FUNCTION trg_cars_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
         (to_jsonb(NEW) - 'logistic_status_id' - 'settlement_status_id' - 'version' - 'updated_at')
         <> (to_jsonb(OLD) - 'logistic_status_id' - 'settlement_status_id' - 'version' - 'updated_at') THEN
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

-- 5. Dziennik błędów: tylko ostatnie 90 dni (czyszczone przy starcie serwera)
CREATE INDEX error_log_at_idx ON error_log (at);
