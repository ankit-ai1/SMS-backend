-- ============================================================================
-- 008_gate_passes.sql  —  Front-office gate passes.
-- ----------------------------------------------------------------------------
-- A clerk raises a pass when someone comes to collect a student mid-day; a
-- principal (or admin) approves it before the child leaves. The gate desk reads
-- the day's list, so out_time is required and the list is filtered on its date.
-- ============================================================================

-- CREATE TYPE has no IF NOT EXISTS, so guard it to keep this file re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gate_pass_status_enum') THEN
    CREATE TYPE gate_pass_status_enum AS ENUM ('pending', 'approved', 'rejected');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS gate_passes (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id       UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    reason           TEXT NOT NULL,
    guardian_name    VARCHAR(200),                 -- who is collecting the child
    out_time         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expected_return  TIMESTAMPTZ,                  -- null = not returning today
    status           gate_pass_status_enum NOT NULL DEFAULT 'pending',
    approved_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    decided_at       TIMESTAMPTZ,
    created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_gate_pass_return CHECK (expected_return IS NULL OR expected_return >= out_time)
);

-- The gate desk queries one day at a time, usually filtered by status.
CREATE INDEX IF NOT EXISTS idx_gate_passes_out_time ON gate_passes (out_time DESC);
CREATE INDEX IF NOT EXISTS idx_gate_passes_status   ON gate_passes (status, out_time DESC);
CREATE INDEX IF NOT EXISTS idx_gate_passes_student  ON gate_passes (student_id);
