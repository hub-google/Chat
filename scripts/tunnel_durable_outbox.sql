-- Applied to live Tunnel tables on 2026-11-17.
-- Backfilled messages are accepted only for their original authenticated sender
-- within 24 hours of a voluntary room exit.
DROP POLICY IF EXISTS "Current participants can insert room messages" ON public.messages;
DROP POLICY IF EXISTS "Tunnel sender inserts current or recently ended messages" ON public.messages;
CREATE POLICY "Tunnel sender inserts current or recently ended messages"
ON public.messages FOR INSERT TO authenticated
WITH CHECK (
  NOT (SELECT public.is_banned())
  AND sender_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.id = messages.match_id
      AND (
        (m.is_active = TRUE AND (
          (SELECT public.is_admin())
          OR ((SELECT auth.uid()) = ANY(m.participants)
             AND (NOT COALESCE(m.is_taken_over,FALSE) OR m.takeover_target IS DISTINCT FROM (SELECT auth.uid())))
        ))
        OR (
          m.is_active = FALSE AND m.ended_reason = 'user_left'
          AND COALESCE(m.is_taken_over,FALSE) = FALSE
          AND m.ended_at > NOW() - INTERVAL '24 hours'
          AND (SELECT auth.uid()) = ANY(m.participants)
        )
      )
  )
);

