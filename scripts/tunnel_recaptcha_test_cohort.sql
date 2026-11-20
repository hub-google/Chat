-- Enforce Google reCAPTCHA for voluntarily enrolled main test accounts only.
-- Existing release users continue to match until an explicit production deployment.
CREATE TABLE IF NOT EXISTS private.tunnel_recaptcha_test_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '24 hours')
);
REVOKE ALL ON private.tunnel_recaptcha_test_users FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.tunnel_chat_recaptcha_test_enroll()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $enroll$
DECLARE v_id uuid:=auth.uid();
BEGIN
  IF v_id IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000';
  END IF;
  INSERT INTO private.tunnel_recaptcha_test_users(user_id,enrolled_at,expires_at)
    VALUES(v_id,now(),now()+interval '24 hours')
    ON CONFLICT(user_id) DO UPDATE SET enrolled_at=now(),expires_at=now()+interval '24 hours';
  RETURN true;
END;
$enroll$;
REVOKE ALL ON FUNCTION public.tunnel_chat_recaptcha_test_enroll() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.tunnel_chat_recaptcha_test_enroll() TO authenticated;

CREATE OR REPLACE FUNCTION public.tunnel_chat_recaptcha_status()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO '' AS $status$
 SELECT jsonb_build_object(
  'required', COALESCE((SELECT enabled FROM private.tunnel_recaptcha_config WHERE singleton),false)
     OR EXISTS (SELECT 1 FROM private.tunnel_recaptcha_test_users t
                WHERE t.user_id=auth.uid() AND t.expires_at>now()),
  'site_key', COALESCE((SELECT site_key FROM private.tunnel_recaptcha_config WHERE singleton),''),
  'verified', EXISTS(
    SELECT 1 FROM private.tunnel_recaptcha_passes p
    WHERE p.user_id=auth.uid() AND p.expires_at>now()
  )
 );
$status$;
REVOKE ALL ON FUNCTION public.tunnel_chat_recaptcha_status() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.tunnel_chat_recaptcha_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_match_user(p_user_id uuid, p_intent character varying, p_gender character varying DEFAULT NULL::character varying, p_target_gender character varying DEFAULT 'any'::character varying, p_city character varying DEFAULT NULL::character varying, p_age integer DEFAULT NULL::integer, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_max_distance_km integer DEFAULT NULL::integer, p_distance_mode character varying DEFAULT 'nearest'::character varying)
 RETURNS TABLE(match_id uuid, matched_user_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_target_row RECORD; v_new_match_id UUID; v_existing public.matches%ROWTYPE; v_my_queue_id UUID;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Not authorized to match this user.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  -- A restricted IP gets exactly the ordinary no-match response, with no queue row.
  IF public.is_banned() THEN
    DELETE FROM public.matching_pool WHERE user_id = p_user_id;
    RETURN QUERY SELECT NULL::UUID, NULL::UUID;
    RETURN;
  END IF;
  -- Test users from main are required to verify without blocking release users.
  -- Once main is promoted, global enabled protects every CHAT account.
  -- Never leak moderation status: the silent-ban no-match branch above stays first.
  IF (
        (SELECT enabled FROM private.tunnel_recaptcha_config WHERE singleton)
        OR EXISTS (SELECT 1 FROM private.tunnel_recaptcha_test_users t
                   WHERE t.user_id=p_user_id AND t.expires_at>now())
     )
     AND NOT EXISTS (
       SELECT 1 FROM private.tunnel_recaptcha_passes p
       WHERE p.user_id=p_user_id AND p.expires_at > now()
     ) THEN
    RAISE EXCEPTION 'CHAT_RECAPTCHA_REQUIRED' USING ERRCODE='P0001';
  END IF;
  -- Gateway-observed IP is stored in a private table, not user-editable profile data.
  INSERT INTO private.tunnel_match_ip_sources(user_id, ip, seen_at)
  VALUES (p_user_id, public.tunnel_request_ip(), now())
  ON CONFLICT(user_id) DO UPDATE SET ip=EXCLUDED.ip, seen_at=EXCLUDED.seen_at;
  -- A simultaneous attempt may otherwise match this user while another
  -- transaction claims them as a target. Lock the caller's own queue row
  -- before checking active matches or searching for another candidate.
  -- SKIP LOCKED on target selection then excludes this user until commit.
  SELECT id INTO v_my_queue_id
  FROM public.matching_pool
  WHERE user_id = p_user_id
  FOR UPDATE;
  SELECT * INTO v_existing FROM public.matches
    WHERE p_user_id = ANY(participants) AND is_active
    ORDER BY created_at DESC LIMIT 1;
  IF v_existing.id IS NOT NULL THEN
    RETURN QUERY SELECT v_existing.id, (SELECT u FROM unnest(v_existing.participants) u WHERE u <> p_user_id LIMIT 1);
    RETURN;
  END IF;
  SELECT * INTO v_target_row FROM public.matching_pool
   WHERE status='waiting' AND user_id<>p_user_id AND intent=p_intent
     AND (p_target_gender='any' OR p_target_gender IS NULL OR gender IS NULL OR gender=p_target_gender)
     AND (target_gender='any' OR target_gender IS NULL OR p_gender IS NULL OR target_gender=p_gender)
     AND (p_max_distance_km IS NULL OR (p_lat IS NOT NULL AND p_lng IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL AND public.haversine_distance(p_lat,p_lng,lat,lng)<=p_max_distance_km))
     AND (max_distance_km IS NULL OR (p_lat IS NOT NULL AND p_lng IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL AND public.haversine_distance(p_lat,p_lng,lat,lng)<=max_distance_km))
     AND (p_distance_mode<>'farthest' OR (p_lat IS NOT NULL AND p_lng IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL AND public.haversine_distance(p_lat,p_lng,lat,lng)>=50))
     AND (distance_mode<>'farthest' OR (p_lat IS NOT NULL AND p_lng IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL AND public.haversine_distance(p_lat,p_lng,lat,lng)>=50))
     AND last_ping_at>NOW()-INTERVAL '10 seconds'
     -- A newly restricted waiting user cannot be claimed by somebody else's poll.
     AND NOT EXISTS (
       SELECT 1 FROM private.tunnel_match_ip_sources src
       JOIN private.tunnel_ip_bans banned ON banned.ip=src.ip AND banned.expires_at>NOW()
       WHERE src.user_id=matching_pool.user_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles other_profile
       WHERE other_profile.id=matching_pool.user_id AND other_profile.status='banned'
     )
   ORDER BY CASE WHEN p_distance_mode='farthest' THEN public.haversine_distance(p_lat,p_lng,lat,lng) END DESC NULLS LAST, created_at ASC
   FOR UPDATE SKIP LOCKED LIMIT 1;

  IF v_target_row.id IS NOT NULL THEN
    INSERT INTO public.matches(participants,intent,is_active,distance_km)
    VALUES (ARRAY[p_user_id,v_target_row.user_id],p_intent,TRUE,
      CASE WHEN p_lat IS NOT NULL AND p_lng IS NOT NULL AND v_target_row.lat IS NOT NULL AND v_target_row.lng IS NOT NULL
           THEN public.haversine_distance(p_lat,p_lng,v_target_row.lat,v_target_row.lng) ELSE NULL END)
    RETURNING id INTO v_new_match_id;
    DELETE FROM public.matching_pool WHERE user_id IN (p_user_id,v_target_row.user_id);
    UPDATE public.profiles SET status='chatting' WHERE id IN (p_user_id,v_target_row.user_id);
    RETURN QUERY SELECT v_new_match_id,v_target_row.user_id;
  ELSE
    INSERT INTO public.matching_pool(user_id,gender,target_gender,intent,city,age,lat,lng,max_distance_km,distance_mode,status,last_ping_at)
    VALUES(p_user_id,p_gender,p_target_gender,p_intent,p_city,p_age,p_lat,p_lng,p_max_distance_km,p_distance_mode,'waiting',NOW())
    ON CONFLICT(user_id) DO UPDATE SET gender=EXCLUDED.gender,target_gender=EXCLUDED.target_gender,intent=EXCLUDED.intent,
      city=EXCLUDED.city,age=EXCLUDED.age,lat=EXCLUDED.lat,lng=EXCLUDED.lng,max_distance_km=EXCLUDED.max_distance_km,
      distance_mode=EXCLUDED.distance_mode,last_ping_at=NOW(),status='waiting';
    RETURN QUERY SELECT NULL::UUID,NULL::UUID;
  END IF;
END;
$function$;
