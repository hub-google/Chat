
-- CHAT IP and phrase moderation. No user-facing access to private source/bans tables.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_device TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_browser TEXT;

CREATE TABLE IF NOT EXISTS private.tunnel_message_sources (
  message_id UUID PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  ip INET,
  ip_source TEXT NOT NULL CHECK (ip_source IN ('gateway','profile_latest','unknown')),
  location_zh TEXT,
  device TEXT,
  browser TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tunnel_message_sources_ip_idx ON private.tunnel_message_sources(ip);
CREATE INDEX IF NOT EXISTS tunnel_messages_recent_text_idx ON public.messages(created_at DESC) WHERE type = 'text';

CREATE TABLE IF NOT EXISTS private.tunnel_ip_bans (
  ip INET PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tunnel_ip_bans_expiry_idx ON private.tunnel_ip_bans(expires_at);
REVOKE ALL ON ALL TABLES IN SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.tunnel_safe_ip(p_value TEXT)
RETURNS INET LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
  IF NULLIF(btrim(p_value), '') IS NULL THEN RETURN NULL; END IF;
  RETURN btrim(p_value)::inet;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.tunnel_request_ip()
RETURNS INET LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE v_headers JSONB; v_forwarded TEXT;
BEGIN
  v_headers := NULLIF(current_setting('request.headers', true), '')::jsonb;
  -- Standard Supabase/PostgREST gateway header, never from profile input.
  v_forwarded := NULLIF(btrim(split_part(COALESCE(v_headers->>'x-forwarded-for', ''), ',', 1)), '');
  IF v_forwarded IS NULL THEN RETURN NULL; END IF;
  RETURN v_forwarded::inet;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.tunnel_request_ip() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tunnel_request_ip() TO authenticated;

CREATE OR REPLACE FUNCTION private.tunnel_capture_message_source()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, private AS $$
DECLARE v_profile RECORD; v_ip INET;
BEGIN
  SELECT last_ip,last_ip_location_zh,last_device,last_browser INTO v_profile
  FROM public.profiles WHERE id = NEW.sender_id;
  v_ip := public.tunnel_request_ip();
  INSERT INTO private.tunnel_message_sources(message_id,ip,ip_source,location_zh,device,browser)
  VALUES (
    NEW.id,
    COALESCE(v_ip, private.tunnel_safe_ip(v_profile.last_ip)),
    CASE WHEN v_ip IS NOT NULL THEN 'gateway'
         WHEN private.tunnel_safe_ip(v_profile.last_ip) IS NOT NULL THEN 'profile_latest'
         ELSE 'unknown' END,
    v_profile.last_ip_location_zh,v_profile.last_device,v_profile.last_browser
  ) ON CONFLICT (message_id) DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tunnel_message_ip_snapshot ON public.messages;
CREATE TRIGGER tunnel_message_ip_snapshot AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION private.tunnel_capture_message_source();
REVOKE ALL ON FUNCTION private.tunnel_capture_message_source() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.is_banned()
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, private AS $$
DECLARE v_ip INET;
BEGIN
  -- Keep administrators able to revoke accidentally overbroad bans in app.
  IF public.is_admin() THEN RETURN FALSE; END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id=auth.uid() AND status='banned') THEN
    RETURN TRUE;
  END IF;
  v_ip := public.tunnel_request_ip();
  RETURN v_ip IS NOT NULL AND EXISTS (
    SELECT 1 FROM private.tunnel_ip_bans WHERE ip=v_ip AND expires_at > now()
  );
END;
$$;
REVOKE ALL ON FUNCTION public.is_banned() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.is_banned() TO authenticated;

CREATE OR REPLACE FUNCTION public.tunnel_access_allowed()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog,public AS $$
  SELECT auth.uid() IS NOT NULL AND NOT public.is_banned();
$$;
REVOKE ALL ON FUNCTION public.tunnel_access_allowed() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.tunnel_access_allowed() TO authenticated;

CREATE OR REPLACE FUNCTION private.tunnel_ban_period(p_duration TEXT)
RETURNS INTERVAL LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  RETURN CASE p_duration
    WHEN '5m' THEN interval '5 minutes'
    WHEN '30m' THEN interval '30 minutes'
    WHEN '1h' THEN interval '1 hour'
    WHEN '6h' THEN interval '6 hours'
    WHEN '24h' THEN interval '24 hours'
    WHEN '7d' THEN interval '7 days'
    WHEN '30d' THEN interval '30 days'
    WHEN '1y' THEN interval '1 year'
    WHEN '10y' THEN interval '10 years'
    ELSE NULL END;
END;
$$;

CREATE OR REPLACE FUNCTION public.tunnel_admin_phrase_ranking(p_hours INTEGER DEFAULT 24)
RETURNS TABLE(phrase TEXT, message_count BIGINT, sender_count BIGINT, ip_count BIGINT)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog,public,private AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
  IF p_hours NOT IN (1,6,24) THEN RAISE EXCEPTION 'Unsupported time range'; END IF;
  RETURN QUERY
  SELECT regexp_replace(btrim(m.content), '[[:space:]]+', ' ', 'g') AS phrase,
         count(*) AS message_count,
         count(DISTINCT m.sender_id) AS sender_count,
         count(DISTINCT COALESCE(s.ip,private.tunnel_safe_ip(p.last_ip))) AS ip_count
  FROM public.messages m
  LEFT JOIN private.tunnel_message_sources s ON s.message_id=m.id
  LEFT JOIN public.profiles p ON p.id=m.sender_id
  WHERE m.type='text' AND m.created_at >= now()-make_interval(hours=>p_hours)
    AND length(btrim(m.content))>0
    AND COALESCE(p.role,'user')<>'admin'
  GROUP BY 1 ORDER BY message_count DESC, sender_count DESC, phrase ASC LIMIT 100;
END;
$$;

CREATE OR REPLACE FUNCTION public.tunnel_admin_phrase_sources(p_hours INTEGER,p_phrase TEXT)
RETURNS TABLE(ip TEXT, source_quality TEXT, country TEXT, region TEXT, district TEXT, device TEXT, browser TEXT, message_count BIGINT, sender_count BIGINT, last_seen TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog,public,private AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
  IF p_hours NOT IN (1,6,24) OR length(p_phrase) > 4000 THEN RAISE EXCEPTION 'Invalid query'; END IF;
  RETURN QUERY
  WITH hits AS (
    SELECT COALESCE(s.ip,private.tunnel_safe_ip(p.last_ip)) AS src_ip,
           CASE WHEN s.ip IS NOT NULL THEN s.ip_source ELSE 'profile_latest' END AS quality,
           COALESCE(s.location_zh,p.last_ip_location_zh,'') AS loc,
           COALESCE(s.device,p.last_device,'') AS dev,
           COALESCE(s.browser,p.last_browser,'') AS brow,
           m.sender_id AS uid,m.created_at AS at
    FROM public.messages m
    LEFT JOIN private.tunnel_message_sources s ON s.message_id=m.id
    LEFT JOIN public.profiles p ON p.id=m.sender_id
    WHERE m.type='text' AND m.created_at >= now()-make_interval(hours=>p_hours)
      AND regexp_replace(btrim(m.content),'[[:space:]]+',' ','g')=p_phrase
      AND COALESCE(p.role,'user')<>'admin'
  )
  SELECT h.src_ip::TEXT,
         CASE WHEN bool_and(h.quality='gateway') THEN 'gateway' ELSE 'estimated' END,
         NULLIF(split_part(max(h.loc),'／',1),''),
         NULLIF(split_part(max(h.loc),'／',2),''),
         NULLIF(split_part(max(h.loc),'／',3),''),
         NULLIF(max(h.dev),''),
         NULLIF(max(h.brow),''),
         count(*),count(DISTINCT h.uid),max(h.at)
  FROM hits h
  GROUP BY h.src_ip
  ORDER BY count(*) DESC, h.src_ip::text NULLS LAST LIMIT 300;
END;
$$;

CREATE OR REPLACE FUNCTION public.tunnel_admin_ban_ip(p_ip TEXT,p_duration TEXT,p_reason TEXT DEFAULT '手動封鎖')
RETURNS TIMESTAMPTZ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,private AS $$
DECLARE v_ip INET; v_period INTERVAL; v_until TIMESTAMPTZ;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
  v_ip := private.tunnel_safe_ip(p_ip);
  v_period := private.tunnel_ban_period(p_duration);
  IF v_ip IS NULL OR v_period IS NULL THEN RAISE EXCEPTION 'Invalid IP or duration'; END IF;
  IF v_ip = public.tunnel_request_ip() THEN RAISE EXCEPTION 'Cannot ban your current IP'; END IF;
  v_until := now()+v_period;
  INSERT INTO private.tunnel_ip_bans(ip,expires_at,reason,created_by)
  VALUES (v_ip,v_until,left(coalesce(p_reason,''),400),auth.uid())
  ON CONFLICT(ip) DO UPDATE SET expires_at=GREATEST(private.tunnel_ip_bans.expires_at,EXCLUDED.expires_at),
    reason=EXCLUDED.reason,created_by=EXCLUDED.created_by,created_at=now()
  RETURNING expires_at INTO v_until;
  RETURN v_until;
END;
$$;

CREATE OR REPLACE FUNCTION public.tunnel_admin_ban_phrase(p_hours INTEGER,p_phrase TEXT,p_duration TEXT)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,private AS $$
DECLARE v_period INTERVAL; v_count INTEGER; v_own_ip INET;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
  v_period:=private.tunnel_ban_period(p_duration);
  IF p_hours NOT IN (1,6,24) OR v_period IS NULL OR length(p_phrase)>4000 OR length(btrim(p_phrase))=0
     THEN RAISE EXCEPTION 'Invalid moderation request'; END IF;
  v_own_ip:=public.tunnel_request_ip();
  WITH sources AS (
    SELECT DISTINCT COALESCE(s.ip,private.tunnel_safe_ip(p.last_ip)) AS ip
    FROM public.messages m
    LEFT JOIN private.tunnel_message_sources s ON s.message_id=m.id
    LEFT JOIN public.profiles p ON p.id=m.sender_id
    WHERE m.type='text' AND m.created_at >= now()-make_interval(hours=>p_hours)
      AND regexp_replace(btrim(m.content),'[[:space:]]+',' ','g')=p_phrase
      AND COALESCE(p.role,'user')<>'admin'
  ), changed AS (
    INSERT INTO private.tunnel_ip_bans(ip,expires_at,reason,created_by)
      SELECT ip,now()+v_period,'常見文字：'||left(p_phrase,300),auth.uid()
      FROM sources WHERE ip IS NOT NULL AND (v_own_ip IS NULL OR ip<>v_own_ip)
    ON CONFLICT(ip) DO UPDATE SET
      expires_at=GREATEST(private.tunnel_ip_bans.expires_at,EXCLUDED.expires_at),
      reason=EXCLUDED.reason,created_by=EXCLUDED.created_by,created_at=now()
    RETURNING ip
  ) SELECT count(*) INTO v_count FROM changed;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.tunnel_admin_list_ip_bans()
RETURNS TABLE(ip TEXT, expires_at TIMESTAMPTZ, reason TEXT, created_at TIMESTAMPTZ, is_active BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog,public,private AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
  RETURN QUERY SELECT b.ip::TEXT,b.expires_at,b.reason,b.created_at,b.expires_at>now()
  FROM private.tunnel_ip_bans b ORDER BY (b.expires_at>now()) DESC,b.created_at DESC LIMIT 300;
END;
$$;

CREATE OR REPLACE FUNCTION public.tunnel_admin_unban_ip(p_ip TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,private AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
  DELETE FROM private.tunnel_ip_bans WHERE ip=private.tunnel_safe_ip(p_ip);
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION private.tunnel_safe_ip(TEXT),private.tunnel_ban_period(TEXT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.tunnel_admin_phrase_ranking(INTEGER),public.tunnel_admin_phrase_sources(INTEGER,TEXT),
  public.tunnel_admin_ban_ip(TEXT,TEXT,TEXT),public.tunnel_admin_ban_phrase(INTEGER,TEXT,TEXT),
  public.tunnel_admin_list_ip_bans(),public.tunnel_admin_unban_ip(TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.tunnel_admin_phrase_ranking(INTEGER),public.tunnel_admin_phrase_sources(INTEGER,TEXT),
  public.tunnel_admin_ban_ip(TEXT,TEXT,TEXT),public.tunnel_admin_ban_phrase(INTEGER,TEXT,TEXT),
  public.tunnel_admin_list_ip_bans(),public.tunnel_admin_unban_ip(TEXT) TO authenticated;
