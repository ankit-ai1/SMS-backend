-- ============================================================================
-- 001_schema_v1.sql  —  School Management System, per-tenant schema (V1)
-- ----------------------------------------------------------------------------
-- Applied as a template to each tenant database (base doc §1.3).
-- 42 tables across Core People (15 + guardians view), Academic Ops (17),
-- Finance (6), System (4). Calendar/event tables are added by
-- 004_calendar_events.sql; auth token tables by 002_auth_tokens.sql.
-- ============================================================================

-- gen_random_uuid() is built into PostgreSQL 13+ (no pgcrypto needed).

-- ---------------------------------------------------------------------------
-- ENUM types
-- ---------------------------------------------------------------------------
CREATE TYPE user_role_enum        AS ENUM ('super_admin','admin','principal','teacher','accountant','clerk','parent','student');
CREATE TYPE user_status_enum      AS ENUM ('active','disabled');
CREATE TYPE linked_entity_enum    AS ENUM ('staff','student','guardian');
CREATE TYPE gender_enum           AS ENUM ('male','female','other');
CREATE TYPE address_type_enum     AS ENUM ('current','permanent');
CREATE TYPE enrollment_status_enum AS ENUM ('active','transferred','withdrawn','graduated');
CREATE TYPE attendance_status_enum AS ENUM ('present','absent','late','excused','half_day');
CREATE TYPE staff_attendance_status_enum AS ENUM ('present','absent','late','on_leave','half_day');
CREATE TYPE leave_status_enum     AS ENUM ('pending','approved','rejected','cancelled');
CREATE TYPE day_of_week_enum      AS ENUM ('monday','tuesday','wednesday','thursday','friday','saturday','sunday');
CREATE TYPE grade_scale_type_enum AS ENUM ('letter','cgpa','percentage');
CREATE TYPE fee_frequency_enum    AS ENUM ('one_time','monthly','quarterly','term','annual');
CREATE TYPE discount_type_enum    AS ENUM ('sibling','merit','need_based','staff_ward','other');
CREATE TYPE allocation_status_enum AS ENUM ('pending','partial','paid','waived','overdue');
CREATE TYPE payment_mode_enum     AS ENUM ('cash','cheque','card','upi','bank_transfer','online');
CREATE TYPE payment_status_enum   AS ENUM ('pending','completed','failed','refunded');
CREATE TYPE refund_status_enum    AS ENUM ('requested','approved','processed','rejected');
CREATE TYPE audit_action_enum     AS ENUM ('INSERT','UPDATE','DELETE');

-- ===========================================================================
-- SYSTEM SERVICE  (users referenced by created_by across the schema, so first)
-- ===========================================================================
CREATE TABLE users (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email              VARCHAR(255) NOT NULL,
    password_hash      VARCHAR(255) NOT NULL,
    role               user_role_enum NOT NULL,
    full_name          VARCHAR(200) NOT NULL,
    phone              VARCHAR(20),
    status             user_status_enum NOT NULL DEFAULT 'active',
    linked_entity_id   UUID,
    linked_entity_type linked_entity_enum,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_users_email UNIQUE (email)
);
CREATE INDEX idx_users_email ON users (lower(email));
CREATE INDEX idx_users_role  ON users (role);

CREATE TABLE audit_logs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name   VARCHAR(100) NOT NULL,
    record_id    UUID,
    action       audit_action_enum NOT NULL,
    changed_by   UUID REFERENCES users(id),
    changes      JSONB,
    request_id   VARCHAR(64),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_table  ON audit_logs (table_name, record_id);
CREATE INDEX idx_audit_actor  ON audit_logs (changed_by);
CREATE INDEX idx_audit_time   ON audit_logs (created_at);

CREATE TABLE notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       VARCHAR(200) NOT NULL,
    body        TEXT,
    type        VARCHAR(50),
    is_read     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_notif_user_unread ON notifications (user_id) WHERE is_read = FALSE;

CREATE TABLE system_settings (
    key         VARCHAR(100) PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_by  UUID REFERENCES users(id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===========================================================================
-- ACADEMIC OPS  (structure that other services reference: years, classes …)
-- ===========================================================================
CREATE TABLE academic_years (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(20) NOT NULL,          -- 2025-2026
    start_date  DATE NOT NULL,
    end_date    DATE NOT NULL,
    is_current  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_year_name UNIQUE (name),
    CONSTRAINT chk_year_dates CHECK (end_date > start_date)
);
-- Only one current year at a time.
CREATE UNIQUE INDEX uq_year_current ON academic_years ((is_current)) WHERE is_current;

CREATE TABLE terms (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academic_year_id  UUID NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
    name              VARCHAR(50) NOT NULL,     -- Term 1, Semester 2
    start_date        DATE NOT NULL,
    end_date          DATE NOT NULL,
    CONSTRAINT chk_term_dates CHECK (end_date > start_date)
);
CREATE INDEX idx_terms_year ON terms (academic_year_id);

CREATE TABLE departments (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_dept_name UNIQUE (name)
);

CREATE TABLE designations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title      VARCHAR(100) NOT NULL,
    CONSTRAINT uq_desig_title UNIQUE (title)
);

CREATE TABLE classes (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name           VARCHAR(50) NOT NULL,        -- Class 1, KG, Class 10
    numeric_order  INTEGER NOT NULL,            -- for sorting
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_class_name UNIQUE (name)
);

CREATE TABLE sections (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id          UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    academic_year_id  UUID NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
    name              VARCHAR(10) NOT NULL,     -- A, B, C
    capacity          INTEGER,
    CONSTRAINT uq_section UNIQUE (class_id, academic_year_id, name)
);
CREATE INDEX idx_sections_class ON sections (class_id, academic_year_id);

CREATE TABLE subjects (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(100) NOT NULL,
    code       VARCHAR(20),
    CONSTRAINT uq_subject_name UNIQUE (name)
);

CREATE TABLE class_subjects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id    UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    subject_id  UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    is_elective BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT uq_class_subject UNIQUE (class_id, subject_id)
);

CREATE TABLE time_slots (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(50) NOT NULL,           -- Period 1
    start_time  TIME NOT NULL,
    end_time    TIME NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT chk_slot_time CHECK (end_time > start_time)
);

CREATE TABLE timetable_entries (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    section_id   UUID NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    subject_id   UUID NOT NULL REFERENCES subjects(id),
    teacher_id   UUID,      -- staff.id (FK added after staff table below)
    time_slot_id UUID NOT NULL REFERENCES time_slots(id),
    day_of_week  day_of_week_enum NOT NULL,
    CONSTRAINT uq_timetable_slot UNIQUE (section_id, day_of_week, time_slot_id)
);
CREATE INDEX idx_timetable_section ON timetable_entries (section_id);
CREATE INDEX idx_timetable_teacher ON timetable_entries (teacher_id);

CREATE TABLE exam_types (
    id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name  VARCHAR(50) NOT NULL,                 -- Unit Test, Midterm, Final
    CONSTRAINT uq_exam_type UNIQUE (name)
);

CREATE TABLE grade_scales (
    id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name   VARCHAR(50) NOT NULL,
    type   grade_scale_type_enum NOT NULL,
    CONSTRAINT uq_grade_scale UNIQUE (name)
);

CREATE TABLE grade_scale_entries (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    grade_scale_id UUID NOT NULL REFERENCES grade_scales(id) ON DELETE CASCADE,
    grade          VARCHAR(5) NOT NULL,          -- A+, B, F
    min_percent    NUMERIC(5,2) NOT NULL,
    max_percent    NUMERIC(5,2) NOT NULL,
    grade_point    NUMERIC(4,2),
    CONSTRAINT chk_grade_range CHECK (max_percent >= min_percent)
);
CREATE INDEX idx_grade_entries_scale ON grade_scale_entries (grade_scale_id);

CREATE TABLE exams (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academic_year_id  UUID NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
    term_id           UUID REFERENCES terms(id),
    exam_type_id      UUID NOT NULL REFERENCES exam_types(id),
    name              VARCHAR(100) NOT NULL,
    start_date        DATE,
    end_date          DATE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_exams_year ON exams (academic_year_id, term_id);

CREATE TABLE exam_subjects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id     UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    subject_id  UUID NOT NULL REFERENCES subjects(id),
    class_id    UUID REFERENCES classes(id),
    exam_date   DATE,
    max_marks   NUMERIC(6,2) NOT NULL DEFAULT 100,
    pass_marks  NUMERIC(6,2),
    CONSTRAINT uq_exam_subject UNIQUE (exam_id, subject_id, class_id)
);
CREATE INDEX idx_exam_subjects_exam ON exam_subjects (exam_id);

-- ===========================================================================
-- CORE PEOPLE  (students, staff, and daily operations)
-- ===========================================================================
CREATE TABLE staff (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_code   VARCHAR(50) NOT NULL,
    first_name      VARCHAR(100) NOT NULL,
    last_name       VARCHAR(100) NOT NULL,
    email           VARCHAR(255),
    phone           VARCHAR(20),
    gender          gender_enum,
    date_of_birth   DATE,
    department_id   UUID REFERENCES departments(id),
    designation_id  UUID REFERENCES designations(id),
    join_date       DATE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    deleted_at      TIMESTAMPTZ,                 -- soft delete
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_staff_code UNIQUE (employee_code)
);
CREATE INDEX idx_staff_dept ON staff (department_id);
CREATE INDEX idx_staff_name ON staff (last_name, first_name);

-- Now that staff exists, wire the timetable teacher FK.
ALTER TABLE timetable_entries
    ADD CONSTRAINT fk_timetable_teacher
    FOREIGN KEY (teacher_id) REFERENCES staff(id);

CREATE TABLE staff_addresses (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id   UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    type       address_type_enum NOT NULL,
    line1      VARCHAR(200) NOT NULL,
    line2      VARCHAR(200),
    city       VARCHAR(100),
    state      VARCHAR(100),
    pincode    VARCHAR(10),
    CONSTRAINT uq_staff_address UNIQUE (staff_id, type)
);

CREATE TABLE staff_documents (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id    UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    doc_type    VARCHAR(50) NOT NULL,
    gcs_path    VARCHAR(500) NOT NULL,           -- object path in GCS bucket
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_staff_docs ON staff_documents (staff_id);

CREATE TABLE students (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admission_number VARCHAR(50) NOT NULL,
    first_name       VARCHAR(100) NOT NULL,
    last_name        VARCHAR(100) NOT NULL,
    date_of_birth    DATE NOT NULL,
    gender           gender_enum,
    blood_group      VARCHAR(5),
    admission_date   DATE,
    nationality      VARCHAR(50),
    religion         VARCHAR(50),
    category         VARCHAR(50),
    aadhaar_ref      VARCHAR(255),               -- tokenised/encrypted, NOT raw Aadhaar
    photo_url        VARCHAR(500),
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    deleted_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_admission_number UNIQUE (admission_number)
);
CREATE INDEX idx_students_name ON students (last_name, first_name);

CREATE TABLE student_addresses (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    type       address_type_enum NOT NULL,
    line1      VARCHAR(200) NOT NULL,
    line2      VARCHAR(200),
    city       VARCHAR(100),
    state      VARCHAR(100),
    pincode    VARCHAR(10),
    CONSTRAINT uq_student_address UNIQUE (student_id, type)
);

CREATE TABLE student_documents (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id  UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    doc_type    VARCHAR(50) NOT NULL,
    gcs_path    VARCHAR(500) NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_student_docs ON student_documents (student_id);

CREATE TABLE student_medical_info (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id    UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    allergies     TEXT,
    conditions    TEXT,
    medications   TEXT,
    notes         TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_medical_student UNIQUE (student_id)
);

CREATE TABLE student_guardians (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id  UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    name        VARCHAR(200) NOT NULL,
    relation    VARCHAR(50) NOT NULL,            -- father, mother, guardian
    phone       VARCHAR(20),
    email       VARCHAR(255),
    is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
    user_id     UUID REFERENCES users(id),       -- parent login, if created
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_guardians_student ON student_guardians (student_id);
CREATE INDEX idx_guardians_user    ON student_guardians (user_id);

CREATE TABLE student_enrollments (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id        UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    section_id        UUID NOT NULL REFERENCES sections(id),
    academic_year_id  UUID NOT NULL REFERENCES academic_years(id),
    roll_number       VARCHAR(20),
    status            enrollment_status_enum NOT NULL DEFAULT 'active',
    enrolled_on       DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_enrollment UNIQUE (student_id, academic_year_id)
);
CREATE INDEX idx_enroll_section ON student_enrollments (section_id);
CREATE INDEX idx_enroll_year    ON student_enrollments (academic_year_id);

CREATE TABLE teacher_subject_assignments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id  UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    subject_id  UUID NOT NULL REFERENCES subjects(id),
    section_id  UUID NOT NULL REFERENCES sections(id),
    CONSTRAINT uq_teacher_assignment UNIQUE (teacher_id, subject_id, section_id)
);
CREATE INDEX idx_tsa_teacher ON teacher_subject_assignments (teacher_id);
CREATE INDEX idx_tsa_section ON teacher_subject_assignments (section_id);

CREATE TABLE class_teachers (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id        UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    section_id        UUID NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    academic_year_id  UUID NOT NULL REFERENCES academic_years(id),
    CONSTRAINT uq_class_teacher UNIQUE (section_id, academic_year_id)
);
CREATE INDEX idx_class_teacher_teacher ON class_teachers (teacher_id);

CREATE TABLE attendance_records (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enrollment_id  UUID NOT NULL REFERENCES student_enrollments(id) ON DELETE CASCADE,
    date           DATE NOT NULL,
    status         attendance_status_enum NOT NULL,
    remarks        VARCHAR(200),
    marked_by      UUID REFERENCES staff(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_attendance UNIQUE (enrollment_id, date)
);
CREATE INDEX idx_attendance_date ON attendance_records (date);

CREATE TABLE staff_attendance (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id   UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    date       DATE NOT NULL,
    status     staff_attendance_status_enum NOT NULL,
    remarks    VARCHAR(200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_staff_attendance UNIQUE (staff_id, date)
);
CREATE INDEX idx_staff_attendance_date ON staff_attendance (date);

CREATE TABLE leave_types (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name           VARCHAR(50) NOT NULL,
    max_days_year  INTEGER,
    CONSTRAINT uq_leave_type UNIQUE (name)
);

CREATE TABLE leave_requests (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id      UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    leave_type_id UUID NOT NULL REFERENCES leave_types(id),
    start_date    DATE NOT NULL,
    end_date      DATE NOT NULL,
    reason        TEXT,
    status        leave_status_enum NOT NULL DEFAULT 'pending',
    reviewed_by   UUID REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_leave_dates CHECK (end_date >= start_date)
);
CREATE INDEX idx_leave_staff  ON leave_requests (staff_id);
CREATE INDEX idx_leave_status ON leave_requests (status);

-- exam_grades / report_cards reference enrollments, so they come after them.
CREATE TABLE exam_grades (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_subject_id UUID NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,
    enrollment_id   UUID NOT NULL REFERENCES student_enrollments(id) ON DELETE CASCADE,
    marks_obtained  NUMERIC(6,2),
    grade           VARCHAR(5),
    remarks         VARCHAR(200),
    entered_by      UUID REFERENCES staff(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_exam_grade UNIQUE (exam_subject_id, enrollment_id)
);
CREATE INDEX idx_exam_grades_enroll ON exam_grades (enrollment_id);

CREATE TABLE report_cards (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enrollment_id  UUID NOT NULL REFERENCES student_enrollments(id) ON DELETE CASCADE,
    term_id        UUID NOT NULL REFERENCES terms(id),
    total_marks    NUMERIC(8,2),
    percentage     NUMERIC(5,2),
    overall_grade  VARCHAR(5),
    rank           INTEGER,
    generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    generated_by   UUID REFERENCES users(id),
    CONSTRAINT uq_report_card UNIQUE (enrollment_id, term_id)
);
CREATE INDEX idx_report_cards_enroll ON report_cards (enrollment_id);

-- ===========================================================================
-- FINANCE
-- ===========================================================================
CREATE TABLE fee_categories (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(100) NOT NULL,           -- Tuition, Lab, Transport
    frequency  fee_frequency_enum NOT NULL DEFAULT 'term',
    CONSTRAINT uq_fee_category UNIQUE (name)
);

CREATE TABLE fee_structures (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fee_category_id   UUID NOT NULL REFERENCES fee_categories(id),
    class_id          UUID NOT NULL REFERENCES classes(id),
    academic_year_id  UUID NOT NULL REFERENCES academic_years(id),
    amount            NUMERIC(10,2) NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_fee_structure UNIQUE (fee_category_id, class_id, academic_year_id),
    CONSTRAINT chk_fee_amount CHECK (amount >= 0)
);
CREATE INDEX idx_fee_struct_class ON fee_structures (class_id, academic_year_id);

CREATE TABLE fee_discounts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          VARCHAR(100) NOT NULL,
    type          discount_type_enum NOT NULL,
    is_percentage BOOLEAN NOT NULL DEFAULT TRUE,
    value         NUMERIC(10,2) NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE student_fee_allocations (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enrollment_id     UUID NOT NULL REFERENCES student_enrollments(id) ON DELETE CASCADE,
    fee_structure_id  UUID NOT NULL REFERENCES fee_structures(id),
    discount_id       UUID REFERENCES fee_discounts(id),
    amount_due        NUMERIC(10,2) NOT NULL,
    amount_paid       NUMERIC(10,2) NOT NULL DEFAULT 0,
    status            allocation_status_enum NOT NULL DEFAULT 'pending',
    due_date          DATE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_allocation UNIQUE (enrollment_id, fee_structure_id),
    CONSTRAINT chk_amounts CHECK (amount_paid >= 0 AND amount_due >= 0)
);
CREATE INDEX idx_alloc_enroll ON student_fee_allocations (enrollment_id);
CREATE INDEX idx_alloc_status ON student_fee_allocations (status);

CREATE TABLE payments (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    allocation_id          UUID NOT NULL REFERENCES student_fee_allocations(id),
    amount                 NUMERIC(10,2) NOT NULL,
    payment_mode           payment_mode_enum NOT NULL,
    status                 payment_status_enum NOT NULL DEFAULT 'completed',
    transaction_reference  VARCHAR(100),
    payment_date           DATE NOT NULL DEFAULT CURRENT_DATE,
    remarks                VARCHAR(200),
    recorded_by            UUID REFERENCES users(id),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_payment_amount CHECK (amount > 0)
);
CREATE INDEX idx_payments_alloc ON payments (allocation_id);
CREATE INDEX idx_payments_date  ON payments (payment_date);

CREATE TABLE fee_refunds (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id    UUID NOT NULL REFERENCES payments(id),
    amount        NUMERIC(10,2) NOT NULL,
    reason        TEXT,
    status        refund_status_enum NOT NULL DEFAULT 'requested',
    requested_by  UUID REFERENCES users(id),
    approved_by   UUID REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_refund_amount CHECK (amount > 0)
);
CREATE INDEX idx_refunds_payment ON fee_refunds (payment_id);

-- ===========================================================================
-- VIEW: guardians  (base doc §3.2 — derived for parent-login lookups)
-- ===========================================================================
CREATE VIEW guardians AS
    SELECT g.id, g.student_id, g.name, g.relation, g.phone, g.email,
           g.is_primary, g.user_id
    FROM student_guardians g;
