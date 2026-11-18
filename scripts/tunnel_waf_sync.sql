CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;


-- CHAT-specific Cloudflare WAF list synchronization. No Workers, no external queue.
-- Token must be provisioned in Supabase Vault as: chat_cf_waf_api_token.
CREATE TABLE IF NOT EXISTS private.tunnel_waf_sync_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  last_payload_md5 TEXT,
  last_attempt_at TIMESTAMPTZ,
  last_accepted_at TIMESTAMPTZ,
  last_http_status INTEGER,
  last_operation_id TEXT,
  last_synced_count INTEGER,
  last_error TEXT
);
INSERT INTO private.tunnel_waf_sync_state (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;
REVOKE ALL ON private.tunnel_waf_sync_state FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.tunnel_waf_sync()
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private
AS $$
DECLARE
  v_token TEXT;
  v_items JSONB;
  v_md5 TEXT;
  v_count INTEGER;
  v_state private.tunnel_waf_sync_state%ROWTYPE;
  v_response private.http_response;
  v_json JSONB;
  v_operation_id TEXT;
BEGIN
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'ip', host(ip),
      'comment', left('CHAT until ' || to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') || ' | ' || reason, 480)
    ) ORDER BY ip::text
  ),'[]'::jsonb),
  count(*)
  INTO v_items,v_count
  FROM private.tunnel_ip_bans
  WHERE expires_at > clock_timestamp();

  IF v_count > 10000 THEN
    UPDATE private.tunnel_waf_sync_state
       SET last_attempt_at=now(),last_error='Too many blocked IPs for the free Cloudflare list (10,000 maximum)'
     WHERE singleton;
    RETURN FALSE;
  END IF;
  v_md5 := md5(v_items::text);
  SELECT * INTO v_state FROM private.tunnel_waf_sync_state WHERE singleton FOR UPDATE;
  IF v_state.last_payload_md5 = v_md5 AND v_state.last_error IS NULL AND v_state.last_accepted_at IS NOT NULL THEN
    RETURN TRUE;
  END IF;

  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets
  WHERE name='chat_cf_waf_api_token'
  ORDER BY created_at DESC LIMIT 1;

  IF NULLIF(btrim(v_token),'') IS NULL THEN
    UPDATE private.tunnel_waf_sync_state
       SET last_attempt_at=now(),last_error='Cloudflare WAF API token not configured in Supabase Vault'
     WHERE singleton;
    RETURN FALSE;
  END IF;

  UPDATE private.tunnel_waf_sync_state
     SET last_attempt_at=now(),last_error='Waiting for Cloudflare API response'
   WHERE singleton;

  SELECT * INTO v_response
  FROM private.http(ROW(
    'PUT'::private.http_method,
    'https://api.cloudflare.com/client/v4/accounts/2374fd4a241005b20563b35af3bdc320/rules/lists/debd9fd18dda49219c2b11cc56773c53/items'::varchar,
    ARRAY[
      ROW('Authorization'::varchar,('Bearer ' || v_token)::varchar)::private.http_header,
      ROW('Accept'::varchar,'application/json'::varchar)::private.http_header
    ]::private.http_header[],
    'application/json'::varchar,
    v_items::text::varchar
  )::private.http_request);

  BEGIN v_json:=v_response.content::jsonb;
  EXCEPTION WHEN OTHERS THEN v_json:='{}'::jsonb; END;

  IF v_response.status BETWEEN 200 AND 299 AND COALESCE((v_json->>'success')::boolean,FALSE) THEN
    v_operation_id := v_json #>> '{result,operation_id}';
    UPDATE private.tunnel_waf_sync_state
       SET last_payload_md5=v_md5, last_accepted_at=now(),
           last_http_status=v_response.status, last_operation_id=v_operation_id,
           last_synced_count=v_count,last_error=NULL
     WHERE singleton;
    RETURN TRUE;
  END IF;

  UPDATE private.tunnel_waf_sync_state
     SET last_http_status=v_response.status,
         last_error=left(COALESCE((v_json->'errors')::text, v_response.content, 'Cloudflare sync failed'), 400)
   WHERE singleton;
  RETURN FALSE;
EXCEPTION WHEN OTHERS THEN
  -- Never cancel the user's database ban because the external firewall is unavailable.
  UPDATE private.tunnel_waf_sync_state
     SET last_attempt_at=now(),last_error=left(SQLERRM,400)
   WHERE singleton;
  RETURN FALSE;
END;
$$;
REVOKE ALL ON FUNCTION private.tunnel_waf_sync() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.tunnel_ip_ban_after_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,private
AS $$
BEGIN
  PERFORM private.tunnel_waf_sync();
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.tunnel_ip_ban_after_change() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS tunnel_sync_waf_on_ip_bans ON private.tunnel_ip_bans;
CREATE TRIGGER tunnel_sync_waf_on_ip_bans
AFTER INSERT OR UPDATE OR DELETE ON private.tunnel_ip_bans
FOR EACH STATEMENT EXECUTE FUNCTION private.tunnel_ip_ban_after_change();

CREATE OR REPLACE FUNCTION public.tunnel_admin_waf_status()
RETURNS TABLE(
  configured BOOLEAN,
  active_bans BIGINT,
  last_attempt_at TIMESTAMPTZ,
  last_accepted_at TIMESTAMPTZ,
  last_http_status INTEGER,
  last_error TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog,public,private
AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
  RETURN QUERY
  SELECT EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='chat_cf_waf_api_token' AND length(decrypted_secret)>0),
         (SELECT COUNT(*) FROM private.tunnel_ip_bans WHERE expires_at>now()),
         s.last_attempt_at,s.last_accepted_at,s.last_http_status,s.last_error
  FROM private.tunnel_waf_sync_state s WHERE singleton;
END;
$$;
REVOKE ALL ON FUNCTION public.tunnel_admin_waf_status() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.tunnel_admin_waf_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.tunnel_admin_waf_resync()
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,private
AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
  RETURN private.tunnel_waf_sync();
END;
$$;
REVOKE ALL ON FUNCTION public.tunnel_admin_waf_resync() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.tunnel_admin_waf_resync() TO authenticated;

-- Minute granularity allows 5-minute bans to expire on the network edge within ~1 minute.
-- Distinct CHAT-only cron job, no change to other projects' scheduled jobs.
SELECT cron.schedule(
  'tunnel-waf-expiry-sync',
  '* * * * *',
  'SELECT private.tunnel_waf_sync();'
);
