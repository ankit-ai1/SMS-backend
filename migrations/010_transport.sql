-- ============================================================================
-- 010_transport.sql  —  Bus routes, stops and student assignments.
-- ----------------------------------------------------------------------------
-- Scope is deliberately routes + stops + who rides which one, plus the monthly
-- fare that the fee desk bills. No GPS, no live tracking.
--
-- The fare lives on the stop, not the route: two children on the same bus pay
-- differently depending on how far down the line they get on. That is also why
-- billing reads the stop rather than a per-class fee structure.
-- ============================================================================

CREATE TABLE IF NOT EXISTS transport_routes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(100) NOT NULL,
    vehicle_number  VARCHAR(30),
    driver_name     VARCHAR(200),
    driver_phone    VARCHAR(20),
    capacity        INTEGER,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_transport_route_name UNIQUE (name),
    CONSTRAINT chk_route_capacity CHECK (capacity IS NULL OR capacity > 0)
);

CREATE TABLE IF NOT EXISTS transport_stops (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    route_id      UUID NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
    stop_name     VARCHAR(200) NOT NULL,
    pickup_time   TIME,
    drop_time     TIME,
    monthly_fare  NUMERIC(10,2) NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_transport_stop UNIQUE (route_id, stop_name),
    CONSTRAINT chk_stop_fare CHECK (monthly_fare >= 0)
);
CREATE INDEX IF NOT EXISTS idx_transport_stops_route ON transport_stops (route_id);

CREATE TABLE IF NOT EXISTS transport_assignments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id  UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    route_id    UUID NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
    stop_id     UUID NOT NULL REFERENCES transport_stops(id) ON DELETE CASCADE,
    start_date  DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date    DATE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- A student rides one bus at a time; ending the assignment frees them up.
    CONSTRAINT uq_transport_active_student UNIQUE (student_id, route_id, start_date),
    CONSTRAINT chk_assignment_dates CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_transport_assign_route   ON transport_assignments (route_id);
CREATE INDEX IF NOT EXISTS idx_transport_assign_student ON transport_assignments (student_id);

-- One partial unique index does the real work: at most one open (end_date IS
-- NULL) assignment per student, whatever route it is on.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transport_one_open_assignment
    ON transport_assignments (student_id) WHERE end_date IS NULL;
