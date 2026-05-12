-- 011 — upstream_channel.supports_streaming (v0.4 providers).
--
-- v0.4 adds full OpenAI-compatible SSE transcoding and a native Gemini
-- adapter. We pre-flag every provider_type row with whether real
-- streaming is wired so admin UI can grey out unsupported channels
-- before the client even hits POST /v1/messages. (All provider_types we
-- ship in v0.4 support streaming — the column is forward-looking for
-- bring-your-own-protocol custom channels and legacy stubs.)
--
-- Idempotent. Rollback: ALTER TABLE upstream_channel DROP COLUMN supports_streaming.

ALTER TABLE upstream_channel
  ADD COLUMN IF NOT EXISTS supports_streaming BOOLEAN NOT NULL DEFAULT TRUE;

-- Custom channels can't be assumed streaming-capable without a probe.
UPDATE upstream_channel
   SET supports_streaming = FALSE
 WHERE provider_type = 'custom'
   AND supports_streaming = TRUE;
