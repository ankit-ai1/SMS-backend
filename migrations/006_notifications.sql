-- ============================================================================
-- 006_notifications.sql  —  Audience-targeted notifications with per-user reads.
-- ----------------------------------------------------------------------------
-- The original notifications table was one row per recipient with an is_read
-- flag, so a notice to 200 parents meant 200 rows and there was no way to say
-- "the whole school" or "everyone in Class 8 A".
--
-- Now a notification is written once and carries its audience; who has read it
-- lives in notification_reads, one row per (notification, user). That is what
-- makes a single notice carry 50 independent read states.
--
-- Existing per-user rows keep working: they become audience = 'user', and their
-- is_read = TRUE flags are backfilled into notification_reads below.
-- ============================================================================

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS audience VARCHAR(20) NOT NULL DEFAULT 'user';
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS audience_role user_role_enum;
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS audience_section_id UUID REFERENCES sections(id) ON DELETE CASCADE;
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- user_id is now only meaningful for audience = 'user'.
ALTER TABLE notifications ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS chk_notification_audience;
ALTER TABLE notifications ADD CONSTRAINT chk_notification_audience CHECK (
  (audience = 'school'  AND user_id IS NULL     AND audience_role IS NULL AND audience_section_id IS NULL)
  OR (audience = 'role'    AND audience_role IS NOT NULL       AND user_id IS NULL AND audience_section_id IS NULL)
  OR (audience = 'section' AND audience_section_id IS NOT NULL AND user_id IS NULL AND audience_role IS NULL)
  OR (audience = 'user'    AND user_id IS NOT NULL             AND audience_role IS NULL AND audience_section_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_notif_audience ON notifications (audience, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_section  ON notifications (audience_section_id)
  WHERE audience_section_id IS NOT NULL;

-- One row per person who has read a notification. No row means unread.
CREATE TABLE IF NOT EXISTS notification_reads (
    notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (notification_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_notif_reads_user ON notification_reads (user_id);

-- Carry the old per-row flag over, so nobody's inbox re-opens as unread.
INSERT INTO notification_reads (notification_id, user_id, read_at)
SELECT id, user_id, created_at
  FROM notifications
 WHERE is_read AND user_id IS NOT NULL
ON CONFLICT DO NOTHING;
