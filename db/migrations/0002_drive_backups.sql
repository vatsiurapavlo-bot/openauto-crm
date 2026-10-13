-- =============================================================================
-- OpenAuto CRM — migracja 0002: Google Drive i kopie zapasowe
-- =============================================================================

-- Połączenie z Google Drive (jedno dla całej instalacji).
-- Token odświeżania jest zaszyfrowany kluczem OPENAUTO_MASTER_KEY (AES-256-GCM) —
-- sam wyciek bazy nie daje dostępu do Dysku.
CREATE TABLE system_integrations (
  provider        text PRIMARY KEY CHECK (provider IN ('google_drive')),
  account_email   text,
  encrypted_token bytea NOT NULL,
  folders         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- nazwa folderu → id na Dysku
  connected_by    uuid REFERENCES users(id),
  connected_at    timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  last_error_at   timestamptz
);

-- Dziennik kopii zapasowych
CREATE TABLE backup_runs (
  id             bigserial PRIMARY KEY,
  trigger        text NOT NULL CHECK (trigger IN ('auto', 'manual')),
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error')),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  file_name      text,
  drive_file_id  text,
  size_bytes     bigint,
  sha256         text,           -- suma kontrolna zaszyfrowanego pliku
  error          text,
  created_by     uuid REFERENCES users(id)
);
CREATE INDEX backup_runs_started_idx ON backup_runs (started_at DESC);

-- Audyt nie może zawierać zaszyfrowanych tokenów (ani hashy haseł / tokenów sesji)
CREATE OR REPLACE FUNCTION trg_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_ws     uuid;
  v_id     text;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_before := to_jsonb(OLD) - 'password_hash' - 'token_hash' - 'encrypted_token'; END IF;
  IF TG_OP <> 'DELETE' THEN v_after  := to_jsonb(NEW) - 'password_hash' - 'token_hash' - 'encrypted_token'; END IF;
  v_ws := coalesce((v_after ->> 'workspace_id')::uuid, (v_before ->> 'workspace_id')::uuid, app_workspace());
  v_id := coalesce(v_after ->> 'id', v_before ->> 'id', v_after ->> 'car_id', v_before ->> 'car_id', v_after ->> 'provider', v_before ->> 'provider');
  IF TG_OP = 'UPDATE' AND v_before = v_after THEN RETURN NULL; END IF;
  INSERT INTO audit_log (workspace_id, user_id, action, entity, entity_id, before, after)
  VALUES (v_ws, app_user(), TG_OP, TG_TABLE_NAME, v_id, v_before, v_after);
  RETURN NULL;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['system_integrations']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION trg_audit()', t, t);
  END LOOP;
END $$;
