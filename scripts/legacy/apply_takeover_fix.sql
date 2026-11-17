DROP POLICY IF EXISTS "Participants or admins can view matches" ON public.matches;
CREATE POLICY "Participants or admins can view matches"
ON public.matches FOR SELECT TO authenticated
USING (((auth.uid() = ANY(participants) OR auth.uid() = takeover_target) AND NOT public.is_banned()) OR public.is_admin());

DROP POLICY IF EXISTS "Messages read policy with takeover isolation" ON public.messages;
CREATE POLICY "Messages read policy with takeover isolation"
ON public.messages FOR SELECT TO authenticated
USING (
    NOT public.is_banned() AND (
        public.is_admin()
        OR EXISTS (
            SELECT 1 FROM public.matches
            WHERE id = messages.match_id AND auth.uid() = ANY(participants)
        )
        OR EXISTS (
            SELECT 1 FROM public.matches
            WHERE id = messages.match_id
              AND takeover_target = auth.uid()
              AND messages.created_at <= takeover_at
        )
    )
);

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_ip_location_zh VARCHAR(255);

CREATE OR REPLACE FUNCTION public.admin_takeover_session(
    p_match_id UUID,
    p_target_user_id UUID,
    p_reason TEXT
) RETURNS BOOLEAN AS $$
DECLARE
    v_admin_id UUID := auth.uid();
    v_participants UUID[];
    v_now TIMESTAMPTZ := NOW();
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'Only administrators can execute takeover.';
    END IF;

    SELECT participants INTO v_participants
    FROM public.matches
    WHERE id = p_match_id AND is_active = TRUE;

    IF v_participants IS NULL OR NOT (p_target_user_id = ANY(v_participants)) THEN
        RAISE EXCEPTION 'Target user is not an active participant in this room.';
    END IF;

    v_participants := array_replace(v_participants, p_target_user_id, v_admin_id);

    UPDATE public.matches
    SET participants = v_participants,
        is_taken_over = TRUE,
        is_takeover = TRUE,
        takeover_by = v_admin_id,
        takeover_target = p_target_user_id,
        takeover_at = v_now
    WHERE id = p_match_id;

    UPDATE public.profiles SET status = 'online' WHERE id = p_target_user_id;

    -- Deliberately do not create a system message. The remaining user must
    -- experience an uninterrupted conversation with the administrator.
    INSERT INTO public.admin_takeovers (match_id, admin_id, target_user_id, reason)
    VALUES (p_match_id, v_admin_id, p_target_user_id, p_reason);

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.admin_takeover_session(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_takeover_session(UUID, UUID, TEXT) TO authenticated;
