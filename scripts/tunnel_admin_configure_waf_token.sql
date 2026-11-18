
-- Accept Cloudflare list-scoped token only from an authenticated CHAT admin.
-- Token travels over TLS to PostgREST and is stored only in Supabase Vault.
CREATE OR REPLACE FUNCTION public.tunnel_admin_configure_waf_token(p_token TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog,public,private,vault AS $$
DECLARE v_token TEXT; v_secret UUID; v_ok BOOLEAN;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Administrator required'; END IF;
  v_token := btrim(COALESCE(p_token,''));
  IF length(v_token) < 20 OR length(v_token) > 256 OR v_token ~ '[[:space:]]'
     THEN RAISE EXCEPTION 'Cloudflare API Token format is invalid'; END IF;

  SELECT id INTO v_secret FROM vault.secrets WHERE name='chat_cf_waf_api_token' LIMIT 1;
  IF v_secret IS NULL THEN
    PERFORM vault.create_secret(v_token,'chat_cf_waf_api_token','CHAT Cloudflare Account Filter Lists Edit');
  ELSE
    PERFORM vault.update_secret(v_secret,new_secret=>v_token);
  END IF;

  v_ok := private.tunnel_waf_sync();
  IF v_ok IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Cloudflare rejected this API Token or list update. Requires Account Filter Lists Edit for this account.';
  END IF;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.tunnel_admin_configure_waf_token(TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.tunnel_admin_configure_waf_token(TEXT) TO authenticated;
