-- 0008_receipt_request_digest: bind each receipt to the request it answered.
--
-- (requester, request_id) is the idempotency key, so a repeat of the same
-- request re-serves the stored receipt. request_digest is the lower-case hex
-- SHA-256 of the canonical request (encounter, purpose, requested categories
-- and question), written with the receipt, so a request id reused for a
-- different request is refused instead of replaying another release. It is a
-- digest only; no request text is stored.
--
-- Receipts written before this migration have no digest; the pipeline treats
-- a missing digest as a mismatch (fail closed).
ALTER TABLE receipts ADD COLUMN request_digest TEXT
  CHECK (request_digest IS NULL OR (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'));
