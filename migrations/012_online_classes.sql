-- ============================================================================
-- 012_online_classes.sql  —  Scheduled online classes (link store only).
-- ----------------------------------------------------------------------------
-- The school schedules a session and pastes the meeting link it got from Meet,
-- Zoom or Teams. There is no integration: nothing here creates or joins a
-- meeting, it only says when one is and where the link points.
-- ============================================================================

CREATE TABLE IF NOT EXISTS online_classes (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    section_id        UUID NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    subject_id        UUID NOT NULL REFERENCES subjects(id),
    title             VARCHAR(200) NOT NULL,
    meeting_url       VARCHAR(1000) NOT NULL,
    scheduled_at      TIMESTAMPTZ NOT NULL,
    duration_minutes  INTEGER NOT NULL DEFAULT 40,
    created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_online_class_duration CHECK (duration_minutes > 0 AND duration_minutes <= 600)
);

-- "What is on for my section, soonest first" is the only query that matters.
CREATE INDEX IF NOT EXISTS idx_online_classes_section
    ON online_classes (section_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_online_classes_schedule
    ON online_classes (scheduled_at);
