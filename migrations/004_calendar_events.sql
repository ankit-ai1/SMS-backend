-- ============================================================================
-- 004_calendar_events.sql  —  Academic Ops calendar/event support (base doc §4)
-- Adds school_events, holidays, school_calendar_config to a tenant DB.
-- Apply after 001_schema_v1.sql.
-- ============================================================================

CREATE TYPE school_event_type_enum AS ENUM (
    'academic', 'cultural', 'sports', 'examination',
    'holiday', 'administrative', 'other'
);

CREATE TYPE holiday_type_enum AS ENUM (
    'national', 'regional', 'religious', 'school', 'weather', 'emergency'
);

CREATE TABLE school_events (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academic_year_id UUID NOT NULL REFERENCES academic_years(id),
    title            VARCHAR(200) NOT NULL,
    description      TEXT,
    event_type       school_event_type_enum NOT NULL,
    start_date       DATE NOT NULL,
    end_date         DATE NOT NULL,
    start_time       TIME,
    end_time         TIME,
    is_all_day       BOOLEAN NOT NULL DEFAULT TRUE,
    location         VARCHAR(200),
    target_classes   UUID[],
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_by       UUID REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_event_dates CHECK (end_date >= start_date)
);
CREATE INDEX idx_events_year ON school_events (academic_year_id, start_date);

CREATE TABLE holidays (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academic_year_id UUID NOT NULL REFERENCES academic_years(id),
    name             VARCHAR(200) NOT NULL,
    description      TEXT,
    holiday_type     holiday_type_enum NOT NULL,
    start_date       DATE NOT NULL,
    end_date         DATE NOT NULL,
    is_recurring     BOOLEAN NOT NULL DEFAULT FALSE,
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_by       UUID REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_holiday_dates CHECK (end_date >= start_date),
    CONSTRAINT uq_holiday_per_year UNIQUE (academic_year_id, name, start_date)
);
CREATE INDEX idx_holidays_year ON holidays (academic_year_id, start_date);

CREATE TABLE school_calendar_config (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academic_year_id   UUID NOT NULL REFERENCES academic_years(id),
    working_days       day_of_week_enum[] NOT NULL
                       DEFAULT '{monday,tuesday,wednesday,thursday,friday}',
    school_start_time  TIME NOT NULL DEFAULT '08:00',
    school_end_time    TIME NOT NULL DEFAULT '14:30',
    half_day_end_time  TIME DEFAULT '11:30',
    total_working_days INTEGER,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_calendar_config_per_year UNIQUE (academic_year_id)
);
