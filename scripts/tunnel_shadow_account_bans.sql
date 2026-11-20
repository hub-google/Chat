-- CHAT shadow account bans. Compatible with the existing IP/phrase shadow bans.
-- Keep moderation state in a private table so a user cannot change their own status to unban.
CREATE TABLE IF NOT EXISTS private.tunnel_account_bans (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  banned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text NOT NULL DEFAULT '管理員限制',
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE private.tunnel_account_bans FROM PUBLIC, anon, authenticated;

-- Preserve any legacy account bans, but never expose the "banned" status via the profile.
INSERT INTO private.tunnel_account_bans (user_id, reason)
SELECT id, '沿用原有帳號限制'
FROM public.profiles WHERE status='banned'
ON CONFLICT (user_id) DO NOTHING;
UPDATE public.profiles SET status='offline' WHERE status='banned';

-- Shared predicate for matching, message persistence, and room-control RLS.
-- Both IP and account restrictions are authoritative on the server.
CREATE OR REPLACE FUNCTION public.is_banned()
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private'
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_ip inet;
BEGIN
  IF public.is_admin() THEN RETURN FALSE; END IF;
  IF v_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM private.tunnel_account_bans b WHERE b.user_id=v_user
  ) THEN
    RETURN TRUE;
  END IF;
  v_ip := public.tunnel_request_ip();
  RETURN v_ip IS NOT NULL AND EXISTS (
    SELECT 1 FROM private.tunnel_ip_bans WHERE ip=v_ip AND expires_at>now()
  );
END;
$$;

-- An administrative account ban must not change any user-readable profile field
-- to "banned" or generate an explicit "banned" room-end reason.
CREATE OR REPLACE FUNCTION public.tunnel_admin_ban_user(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_role text;
  v_room record;
BEGIN
  IF (SELECT auth.uid()) IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only Tunnel administrators can ban a user' USING ERRCODE = '42501';
  END IF;
  IF p_user_id=(SELECT auth.uid()) THEN
    RAISE EXCEPTION 'Administrators cannot ban their own account';
  END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id=p_user_id FOR UPDATE;
  IF v_role IS NULL THEN RETURN FALSE; END IF;
  IF v_role='admin' THEN
    RAISE EXCEPTION 'Cannot ban an administrator through this workflow';
  END IF;

  INSERT INTO private.tunnel_account_bans(user_id,banned_by,reason)
  VALUES(p_user_id,auth.uid(),'管理員限制')
  ON CONFLICT(user_id) DO UPDATE SET banned_by=EXCLUDED.banned_by,
    reason=EXCLUDED.reason,created_at=now();

  -- Make the lobby appear ordinary; authority lives only in the private table.
  UPDATE public.profiles SET status='offline',updated_at=now() WHERE id=p_user_id;
  DELETE FROM public.matching_pool WHERE user_id=p_user_id;

  FOR v_room IN
    UPDATE public.matches
      SET is_active=false, ended_reason='user_left', ended_at=now()
      WHERE is_active=true AND p_user_id=ANY(participants)
      RETURNING participants
  LOOP
    UPDATE public.profiles p SET status='online'
    WHERE p.id=ANY(v_room.participants)
      AND p.id<>p_user_id
      AND p.status='chatting'
      AND NOT EXISTS (
        SELECT 1 FROM public.matches m
        WHERE m.is_active=true AND p.id=ANY(m.participants)
      );
  END LOOP;
  RETURN TRUE;
END;
$$;

-- Authorised rollback for mistaken account bans, without account recreation.
CREATE OR REPLACE FUNCTION public.tunnel_admin_unban_user(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE v_deleted integer;
BEGIN
  IF (SELECT auth.uid()) IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501';
  END IF;
  DELETE FROM private.tunnel_account_bans WHERE user_id=p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  UPDATE public.profiles SET status='offline',updated_at=now()
    WHERE id=p_user_id AND status='banned';
  RETURN v_deleted > 0;
END;
$$;
REVOKE ALL ON FUNCTION public.tunnel_admin_unban_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tunnel_admin_unban_user(uuid) TO authenticated;

-- Do not ask shadow-banned users for additional CAPTCHA; no visible verification
-- failure should distinguish them from a normal waiting participant.
CREATE OR REPLACE FUNCTION public.tunnel_chat_recaptcha_status()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT jsonb_build_object(
    'required', CASE WHEN public.is_banned() THEN false ELSE
      COALESCE((SELECT enabled FROM private.tunnel_recaptcha_config WHERE singleton),false)
      OR EXISTS (
        SELECT 1 FROM private.tunnel_recaptcha_test_users t
        WHERE t.user_id=auth.uid() AND t.expires_at>now()
      ) END,
    'site_key', COALESCE((SELECT site_key FROM private.tunnel_recaptcha_config WHERE singleton),''),
    'verified', EXISTS (
      SELECT 1 FROM private.tunnel_recaptcha_passes p
      WHERE p.user_id=auth.uid() AND p.expires_at>now()
    )
  );
$$;
