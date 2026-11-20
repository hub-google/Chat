-- Google reCAPTCHA v3 proof for CHAT match RPC, isolated from other products
-- This SQL only creates a disabled gate. Enable after Google site and server secrets are verified.
CREATE TABLE IF NOT EXISTS private.tunnel_recaptcha_config (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false
);
INSERT INTO private.tunnel_recaptcha_config(singleton,enabled) VALUES (true,false)
 ON CONFLICT(singleton) DO NOTHING;
REVOKE ALL ON private.tunnel_recaptcha_config FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS private.tunnel_recaptcha_passes (
 user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 verified_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 score numeric(4,3) NOT NULL CHECK(score>=0 AND score<=1),
 hostname text NOT NULL
);
REVOKE ALL ON private.tunnel_recaptcha_passes FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS tunnel_recaptcha_passes_expires_idx ON private.tunnel_recaptcha_passes(expires_at);

CREATE OR REPLACE FUNCTION public.tunnel_chat_recaptcha_status()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO '' AS $status$
 SELECT jsonb_build_object(
  'required', COALESCE((SELECT enabled FROM private.tunnel_recaptcha_config WHERE singleton),false),
  'verified', EXISTS(
    SELECT 1 FROM private.tunnel_recaptcha_passes p
    WHERE p.user_id=auth.uid() AND p.expires_at>now()
  )
 );
$status$;
REVOKE ALL ON FUNCTION public.tunnel_chat_recaptcha_status() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.tunnel_chat_recaptcha_status() TO authenticated;

-- Only an Edge Function holding the service role may save Google-verified results.
-- Client-provided tokens, scores and identity alone never grant access.
CREATE OR REPLACE FUNCTION public.tunnel_chat_recaptcha_mark_verified(
 p_user_id uuid,p_score numeric,p_hostname text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO '' AS $mark$
BEGIN
 IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role'
    THEN RAISE EXCEPTION 'service_role required' USING ERRCODE='42501'; END IF;
 IF p_user_id IS NULL OR p_score IS NULL OR p_score<0 OR p_score>1
    OR p_hostname IS NULL OR length(p_hostname)>255
    THEN RAISE EXCEPTION 'invalid verification'; END IF;
 INSERT INTO private.tunnel_recaptcha_passes(user_id,verified_at,expires_at,score,hostname)
 VALUES(p_user_id,now(),now()+interval '12 hours',p_score,p_hostname)
 ON CONFLICT(user_id) DO UPDATE SET
  verified_at=EXCLUDED.verified_at,
  expires_at=EXCLUDED.expires_at,
  score=EXCLUDED.score, hostname=EXCLUDED.hostname;
 RETURN true;
END;
$mark$;
REVOKE ALL ON FUNCTION public.tunnel_chat_recaptcha_mark_verified(uuid,numeric,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tunnel_chat_recaptcha_mark_verified(uuid,numeric,text) TO service_role;

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
  -- CHAT-specific server-enforced reCAPTCHA gate. Disabled until keys are deployed.
  -- Never leak moderation status: the silent-ban no-match branch above stays first.
  IF (SELECT enabled FROM private.tunnel_recaptcha_config WHERE singleton)
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

-- When deploying secrets, flip flag only after validating Google/Edge Function end-to-end:
-- UPDATE private.tunnel_recaptcha_config SET enabled=true WHERE singleton;
