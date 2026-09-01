-- ============================================================================
-- 005_document_files.sql  —  Real file uploads for student documents.
-- ----------------------------------------------------------------------------
-- Until now student_documents held only a path string that somebody typed in by
-- hand. The upload endpoints store the file itself, so we keep what the UI needs
-- to show it: original name, mime type and size.
--
-- All three are nullable on purpose: rows created before uploads existed have no
-- file behind them, and the API returns null rather than failing for those.
-- ============================================================================

ALTER TABLE student_documents ADD COLUMN IF NOT EXISTS file_name  VARCHAR(255);
ALTER TABLE student_documents ADD COLUMN IF NOT EXISTS mime_type  VARCHAR(100);
ALTER TABLE student_documents ADD COLUMN IF NOT EXISTS size_bytes BIGINT;

ALTER TABLE student_documents
  DROP CONSTRAINT IF EXISTS chk_document_size;
ALTER TABLE student_documents
  ADD CONSTRAINT chk_document_size CHECK (size_bytes IS NULL OR size_bytes >= 0);
