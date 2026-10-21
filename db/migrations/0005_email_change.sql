-- =============================================================================
-- OpenAuto CRM — migracja 0005: zmiana własnego adresu e-mail (logowania)
-- Tylko dodanie dozwolonego zdarzenia EMAIL_CHANGED w dzienniku logowań.
-- Zgodne wstecz: poprzednia wersja kodu używa wyłącznie dotychczasowych zdarzeń.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_log_auth_event(p_ws uuid, p_user uuid, p_action text, p_details jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_action NOT IN ('LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'PASSWORD_CHANGED', 'EMAIL_CHANGED') THEN
    RAISE EXCEPTION 'Niedozwolone zdarzenie: %', p_action;
  END IF;
  INSERT INTO audit_log (workspace_id, user_id, action, entity, entity_id, after)
  VALUES (p_ws, p_user, p_action, 'auth', p_user::text, p_details);
END $$;
