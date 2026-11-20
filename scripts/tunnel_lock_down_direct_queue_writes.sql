-- CHAT queue writes must be performed only by the SECURITY DEFINER atomic matcher.
-- Without this, a script can bypass Google reCAPTCHA by inserting directly.
DROP POLICY IF EXISTS "Users manage own queue row" ON public.matching_pool;

CREATE POLICY "CHAT users view own queue row" ON public.matching_pool
  FOR SELECT TO authenticated
  USING ((user_id=(SELECT auth.uid()) AND NOT public.is_banned()) OR public.is_admin());

CREATE POLICY "CHAT users delete own queue row" ON public.matching_pool
  FOR DELETE TO authenticated
  USING ((user_id=(SELECT auth.uid()) AND NOT public.is_banned()) OR public.is_admin());

CREATE POLICY "CHAT admins insert queue rows" ON public.matching_pool
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "CHAT admins update queue rows" ON public.matching_pool
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- RPC public.fn_match_user / tunnel_cancel_matching / housekeeping run as postgres
-- and continue to handle atomic queue writes and cleanup.
