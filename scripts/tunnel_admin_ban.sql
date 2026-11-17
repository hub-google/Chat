-- Tunnel-specific existing-install migration. Never modifies other apps' data.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_status_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_status_check
  CHECK (status IN ('online','matching','chatting','offline','banned'));

CREATE OR REPLACE FUNCTION public.tunnel_admin_ban_user(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_room record;
BEGIN
  IF (SELECT auth.uid()) IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only Tunnel administrators can ban a user' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'Administrators cannot ban their own account';
  END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id=p_user_id FOR UPDATE;
  IF v_role IS NULL THEN RETURN FALSE; END IF;
  IF v_role = 'admin' THEN
    RAISE EXCEPTION 'Cannot ban an administrator through this workflow';
  END IF;
  UPDATE public.profiles SET status='banned', updated_at=now() WHERE id=p_user_id;
  DELETE FROM public.matching_pool WHERE user_id=p_user_id;
  FOR v_room IN
    UPDATE public.matches
    SET is_active=false, ended_reason='banned', ended_at=now()
    WHERE is_active=true AND p_user_id=ANY(participants)
    RETURNING participants
  LOOP
    UPDATE public.profiles p SET status='online'
    WHERE p.id=ANY(v_room.participants)
      AND p.id<>p_user_id
      AND p.status='chatting'
      AND NOT EXISTS (SELECT 1 FROM public.matches m WHERE m.is_active=true AND p.id=ANY(m.participants));
  END LOOP;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.tunnel_admin_ban_user(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tunnel_admin_ban_user(uuid) TO authenticated;
