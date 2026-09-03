-- ============================================================================
-- 009_exam_seating.sql  —  Exam rooms and generated seat allocations.
-- ----------------------------------------------------------------------------
-- A room is a grid; a seat allocation puts one enrolment on one (row, column)
-- of one room for one exam. The generator re-runs freely: allocations for an
-- exam are wiped and rebuilt in a single transaction, and the unique keys below
-- make a double-write impossible even if two people press the button at once.
--
-- The grid columns are row_count/column_count rather than "rows"/"columns"
-- because both of those are keywords in Postgres grammar; the API still calls
-- them rows/columns.
-- ============================================================================

CREATE TABLE IF NOT EXISTS exam_rooms (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          VARCHAR(100) NOT NULL,
    row_count     INTEGER NOT NULL,
    column_count  INTEGER NOT NULL,
    capacity      INTEGER NOT NULL,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_exam_room_name UNIQUE (name),
    CONSTRAINT chk_exam_room_grid CHECK (row_count > 0 AND column_count > 0),
    -- Capacity may be less than the grid (a broken desk, a spacing policy) but
    -- never more than there are physical seats.
    CONSTRAINT chk_exam_room_capacity CHECK (capacity > 0 AND capacity <= row_count * column_count)
);

CREATE TABLE IF NOT EXISTS exam_seat_allocations (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id        UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    room_id        UUID NOT NULL REFERENCES exam_rooms(id) ON DELETE CASCADE,
    enrollment_id  UUID NOT NULL REFERENCES student_enrollments(id) ON DELETE CASCADE,
    row_no         INTEGER NOT NULL,
    column_no      INTEGER NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_seat_position CHECK (row_no > 0 AND column_no > 0),
    -- One student per exam, one student per seat.
    CONSTRAINT uq_seat_per_student UNIQUE (exam_id, enrollment_id),
    CONSTRAINT uq_seat_position    UNIQUE (exam_id, room_id, row_no, column_no)
);

CREATE INDEX IF NOT EXISTS idx_seat_alloc_exam ON exam_seat_allocations (exam_id);
CREATE INDEX IF NOT EXISTS idx_seat_alloc_room ON exam_seat_allocations (room_id);
