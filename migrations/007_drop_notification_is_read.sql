-- ============================================================================
-- 007_drop_notification_is_read.sql
-- ----------------------------------------------------------------------------
-- notification_reads has been the single source of truth for "who has read
-- what" since 006, and that migration backfilled every is_read = TRUE row into
-- it. Nothing reads the column any more, so drop it rather than leave a second,
-- slowly-diverging answer to the same question.
--
-- Belt and braces: run the backfill once more before dropping, so a row written
-- by an old build between 006 and this migration is not lost.
-- ============================================================================

-- Guarded so the file stays re-runnable: once the column is gone this is a
-- no-op instead of a parse error on a column that no longer exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'notifications' AND column_name = 'is_read'
  ) THEN
    INSERT INTO notification_reads (notification_id, user_id, read_at)
    SELECT id, user_id, created_at
      FROM notifications
     WHERE is_read AND user_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- The partial index was defined on is_read, so it goes with the column.
DROP INDEX IF EXISTS idx_notif_user_unread;
ALTER TABLE notifications DROP COLUMN IF EXISTS is_read;

-- Per-user notices are still looked up by recipient.
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications (user_id)
  WHERE user_id IS NOT NULL;
