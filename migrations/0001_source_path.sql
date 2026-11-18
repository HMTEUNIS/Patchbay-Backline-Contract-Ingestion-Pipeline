-- Relative path of the source PDF, with no host or bucket prefix.
-- The same value is stored on the contract and on each of its clause rows.
-- A demo app prefixes this path; do not serve the folder from a public app in production.

ALTER TABLE label.contracts
  ADD COLUMN IF NOT EXISTS source_path TEXT;

ALTER TABLE rag.contract_chunks
  ADD COLUMN IF NOT EXISTS source_path TEXT;
