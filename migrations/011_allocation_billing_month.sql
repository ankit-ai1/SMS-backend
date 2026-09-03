-- ============================================================================
-- 011_allocation_billing_month.sql  —  Recurring (monthly) fee allocations.
-- ----------------------------------------------------------------------------
-- Transport is billed every month against ONE "Transport Fee" structure, but
-- uq_allocation (enrollment_id, fee_structure_id) allowed a student exactly one
-- allocation per structure ever — so October's run saw September's row and
-- skipped it. The school's only workaround was a new fee structure each month,
-- which is not how a fee structure is meant to be used.
--
-- billing_month (YYYY-MM) splits allocations into two kinds, each with its own
-- uniqueness rule:
--   NULL      — one-off fees (tuition, lab). Still one per structure, exactly as
--               before, so nothing about existing billing changes.
--   'YYYY-MM' — recurring fees. One per structure PER MONTH.
--
-- Two partial unique indexes rather than one constraint over both, because a
-- plain UNIQUE with a nullable column treats NULLs as distinct and would let
-- one-off fees be allocated twice.
-- ============================================================================

ALTER TABLE student_fee_allocations
  ADD COLUMN IF NOT EXISTS billing_month VARCHAR(7);

ALTER TABLE student_fee_allocations
  DROP CONSTRAINT IF EXISTS chk_allocation_billing_month;
ALTER TABLE student_fee_allocations
  ADD CONSTRAINT chk_allocation_billing_month
  CHECK (billing_month IS NULL OR billing_month ~ '^\d{4}-(0[1-9]|1[0-2])$');

-- Replace the all-or-nothing constraint with the two rules above.
ALTER TABLE student_fee_allocations DROP CONSTRAINT IF EXISTS uq_allocation;

CREATE UNIQUE INDEX IF NOT EXISTS uq_allocation_once
    ON student_fee_allocations (enrollment_id, fee_structure_id)
    WHERE billing_month IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_allocation_monthly
    ON student_fee_allocations (enrollment_id, fee_structure_id, billing_month)
    WHERE billing_month IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_allocation_billing_month
    ON student_fee_allocations (billing_month)
    WHERE billing_month IS NOT NULL;
