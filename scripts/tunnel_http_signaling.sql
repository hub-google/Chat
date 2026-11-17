-- Tunnel-only signaling. Does not modify other Supabase project tables.
-- Only the two active members can exchange their SDP descriptions.
CREATE TABLE IF NOT EXISTS public.tunnel_webrtc_signals (
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('offer', 'answer')),
  sdp jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, sender_id)
);

ALTER TABLE public.tunnel_webrtc_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tunnel_webrtc_signals FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.tunnel_webrtc_signals TO authenticated;

DROP POLICY IF EXISTS "Tunnel participants read signals" ON public.tunnel_webrtc_signals;
CREATE POLICY "Tunnel participants read signals"
ON public.tunnel_webrtc_signals FOR SELECT TO authenticated
USING (
  NOT public.is_banned()
  AND EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.id = match_id AND m.is_active = TRUE
      AND auth.uid() = ANY(m.participants)
  )
);

DROP POLICY IF EXISTS "Tunnel participants create own signals" ON public.tunnel_webrtc_signals;
CREATE POLICY "Tunnel participants create own signals"
ON public.tunnel_webrtc_signals FOR INSERT TO authenticated
WITH CHECK (
  NOT public.is_banned()
  AND sender_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.id = match_id AND m.is_active = TRUE
      AND auth.uid() = ANY(m.participants)
  )
);

DROP POLICY IF EXISTS "Tunnel participants replace own signals" ON public.tunnel_webrtc_signals;
CREATE POLICY "Tunnel participants replace own signals"
ON public.tunnel_webrtc_signals FOR UPDATE TO authenticated
USING (
  sender_id = auth.uid()
  AND NOT public.is_banned()
  AND EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.id = match_id AND m.is_active = TRUE
      AND auth.uid() = ANY(m.participants)
  )
)
WITH CHECK (
  sender_id = auth.uid()
  AND NOT public.is_banned()
  AND EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.id = match_id AND m.is_active = TRUE
      AND auth.uid() = ANY(m.participants)
  )
);
