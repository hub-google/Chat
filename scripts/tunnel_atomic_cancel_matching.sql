-- Transactional cancellation of waiting users and just-created matches.
CREATE OR REPLACE FUNCTION public.tunnel_cancel_matching()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_waiting_id uuid;
  v_match record;
  v_changed boolean := false;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 0));
  SELECT q.id INTO v_waiting_id FROM public.matching_pool q
    WHERE q.user_id = v_user FOR UPDATE;
  DELETE FROM public.matching_pool WHERE user_id = v_user;
  IF v_waiting_id IS NOT NULL THEN v_changed := true; END IF;
  FOR v_match IN
    SELECT id FROM public.matches WHERE is_active=true AND v_user=ANY(participants)
    ORDER BY created_at DESC FOR UPDATE
  LOOP
    PERFORM public.leave_match(v_match.id);
    v_changed := true;
  END LOOP;
  UPDATE public.profiles SET status='online',updated_at=now()
    WHERE id=v_user AND status='matching';
  RETURN v_changed;
END;
$$;
REVOKE ALL ON FUNCTION public.tunnel_cancel_matching() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.tunnel_cancel_matching() TO authenticated;
