-- =============================================================================
-- OpenAuto CRM — migracja 0004: zatwierdzenie uruchomienia z prawdziwymi danymi
-- Dopóki Właściciel nie zatwierdzi (po kontroli bezpieczeństwa), CRM pokazuje baner „tryb testowy”.
-- =============================================================================

CREATE TABLE system_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER system_settings_audit AFTER INSERT OR UPDATE OR DELETE ON system_settings
  FOR EACH ROW EXECUTE FUNCTION trg_audit();
