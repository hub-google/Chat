-- Existing Supabase installation: pg_cron must already be enabled.
-- This job operates on Tunnel's matchmaking/signaling tables only.
CREATE INDEX IF NOT EXISTS idx_tunnel_signals_cleanup ON public.tunnel_webrtc_signals(created_at);
CREATE OR REPLACE FUNCTION public.tunnel_housekeeping()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
 DELETE FROM public.matching_pool WHERE last_ping_at < now() - interval '20 seconds';
 DELETE FROM public.tunnel_webrtc_signals s
 WHERE s.created_at < now() - interval '3 hours'
    OR NOT EXISTS (SELECT 1 FROM public.matches m WHERE m.id = s.match_id AND m.is_active = true);
END;
$$;
REVOKE ALL ON FUNCTION public.tunnel_housekeeping() FROM PUBLIC, anon, authenticated;
SELECT cron.schedule('tunnel-housekeeping','*/15 * * * *','SELECT public.tunnel_housekeeping();');
