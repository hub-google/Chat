-- Existing Tunnel installation only: allow matching offer/answer on reconnect.
ALTER TABLE public.tunnel_webrtc_signals ADD COLUMN IF NOT EXISTS negotiation_id uuid;
GRANT DELETE ON public.tunnel_webrtc_signals TO authenticated;
DROP POLICY IF EXISTS "Tunnel participants remove own signal" ON public.tunnel_webrtc_signals;
CREATE POLICY "Tunnel participants remove own signal"
ON public.tunnel_webrtc_signals FOR DELETE TO authenticated
USING (
 sender_id = (SELECT auth.uid()) AND NOT (SELECT public.is_banned())
 AND EXISTS (SELECT 1 FROM public.matches m
   WHERE m.id = match_id AND m.is_active = TRUE
   AND (SELECT auth.uid()) = ANY(m.participants))
);
