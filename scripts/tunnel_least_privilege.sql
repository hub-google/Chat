-- Applied to Tunnel only in the shared database. Requires the current outbox
-- policy from scripts/tunnel_durable_outbox.sql, which already exists on prod.
-- Browser users receive only the operations the current frontend needs.
-- In particular, RLS does NOT protect against TRUNCATE.
REVOKE ALL ON TABLE
  public.matches, public.messages, public.profiles, public.matching_pool,
  public.chat_reports, public.admin_takeovers, public.topic_categories,
  public.topic_cards, public.tunnel_webrtc_signals
FROM authenticated;
GRANT SELECT ON public.matches, public.admin_takeovers TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT, DELETE ON public.matching_pool TO authenticated;
GRANT SELECT ON public.messages TO authenticated;
GRANT INSERT (id, match_id, sender_id, content, type) ON public.messages TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.chat_reports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.topic_categories, public.topic_cards TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.tunnel_webrtc_signals TO authenticated;

ALTER POLICY "Tunnel sender inserts current or recently ended messages"
ON public.messages TO authenticated
WITH CHECK (
  NOT (SELECT public.is_banned())
  AND sender_id = (SELECT auth.uid())
  AND (type IN ('text','image') OR ((SELECT public.is_admin()) AND type='system'))
  AND EXISTS (
    SELECT 1 FROM public.matches m WHERE m.id = messages.match_id
      AND (
        (m.is_active=TRUE AND (
          (SELECT public.is_admin())
          OR ((SELECT auth.uid()) = ANY(m.participants)
              AND (NOT COALESCE(m.is_taken_over,FALSE) OR m.takeover_target IS DISTINCT FROM (SELECT auth.uid())))
        ))
        OR (m.is_active=FALSE AND m.ended_reason='user_left'
            AND COALESCE(m.is_taken_over,FALSE)=FALSE
            AND m.ended_at>NOW()-INTERVAL '24 hours'
            AND (SELECT auth.uid())=ANY(m.participants))
      )
  )
);
ALTER TABLE public.messages
  ADD CONSTRAINT tunnel_messages_content_length_chk CHECK (char_length(content) BETWEEN 1 AND 4000),
  ADD CONSTRAINT tunnel_messages_type_allowed_chk CHECK (type IS NOT NULL AND type IN ('text','image','system'));
