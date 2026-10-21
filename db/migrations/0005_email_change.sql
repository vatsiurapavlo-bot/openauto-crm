-- =============================================================================
-- OpenAuto CRM — migracja 0005: zmiana własnego adresu e-mail (logowania)
-- Dodaje tylko nową funkcję — zgodne wstecz (poprzednia wersja kodu jej nie używa).
-- =============================================================================

-- Konto użytkownika jest wspólne dla wszystkich przestrzeni roboczych, więc zmiana e-maila
-- trafia do dziennika KAŻDEJ przestrzeni, w której użytkownik jest aktywnym członkiem
-- (właściciel każdej z nich widzi, że adres został zmieniony). Dotyczy wyłącznie bieżącego użytkownika.
CREATE FUNCTION app_log_email_changed(p_details jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user() IS NULL THEN
    RAISE EXCEPTION 'Brak aktywnej sesji' USING ERRCODE = '42501';
  END IF;
  INSERT INTO audit_log (workspace_id, user_id, action, entity, entity_id, after)
  SELECT m.workspace_id, app_user(), 'EMAIL_CHANGED', 'auth', app_user()::text, p_details
  FROM workspace_members m
  WHERE m.user_id = app_user() AND m.active;
END $$;
