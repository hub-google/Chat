-- CHAT Google reCAPTCHA configuration via Supabase Vault, no GitHub Secrets required.
-- Public site key is non-secret; only Edge Function service_role may read Vault secret.
ALTER TABLE private.tunnel_recaptcha_config
  ADD COLUMN IF NOT EXISTS site_key text NOT NULL DEFAULT '';

CREATE OR REPLACE FUNCTION public.tunnel_chat_recaptcha_status()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO '' AS $status$
 SELECT jsonb_build_object(
  'required', COALESCE((SELECT enabled FROM private.tunnel_recaptcha_config WHERE singleton),false),
  'site_key', COALESCE((SELECT site_key FROM private.tunnel_recaptcha_config WHERE singleton),''),
  'verified', EXISTS(
    SELECT 1 FROM private.tunnel_recaptcha_passes p
    WHERE p.user_id=auth.uid() AND p.expires_at>now()
  )
 );
$status$;
REVOKE ALL ON FUNCTION public.tunnel_chat_recaptcha_status() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.tunnel_chat_recaptcha_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.tunnel_chat_recaptcha_get_secret()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO '' AS $secret$
DECLARE v_secret text;
BEGIN
 IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role'
   THEN RAISE EXCEPTION 'service_role required' USING ERRCODE='42501'; END IF;

 SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
 WHERE name='chat_recaptcha_secret_key'
 ORDER BY created_at DESC LIMIT 1;
 RETURN v_secret;
END;
$secret$;
REVOKE ALL ON FUNCTION public.tunnel_chat_recaptcha_get_secret() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tunnel_chat_recaptcha_get_secret() TO service_role;

-- Provision directly using authorized SQL after obtaining a Google reCAPTCHA v3 key pair:
-- SELECT vault.create_secret('<private-google-secret>', 'chat_recaptcha_secret_key', 'CHAT Google reCAPTCHA v3 backend verification secret');
-- UPDATE private.tunnel_recaptcha_config SET site_key='<public-google-site-key>' WHERE singleton;
-- Enable only after the Google siteverify end-to-end test succeeds.
