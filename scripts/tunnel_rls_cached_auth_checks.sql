-- Preserve each existing Tunnel RLS policy's exact condition, but evaluate

-- stable auth/admin/ban checks once per SQL statement instead of per row.

-- Applies only to the six Tunnel-owned tables named below.

ALTER POLICY "Users can create chat_reports" ON public."chat_reports"
  WITH CHECK ((((SELECT auth.uid()) = reporter_id) AND (NOT is_banned())));

ALTER POLICY "Participants or admins can view matches" ON public."matches"
  USING ((((((SELECT auth.uid()) = ANY (participants)) OR ((SELECT auth.uid()) = takeover_target)) AND (NOT is_banned())) OR is_admin()));

ALTER POLICY "Users manage own queue row" ON public."matching_pool"
  USING (((((SELECT auth.uid()) = user_id) AND (NOT is_banned())) OR is_admin()))
  WITH CHECK (((((SELECT auth.uid()) = user_id) AND (NOT is_banned())) OR is_admin()));

ALTER POLICY "Messages read policy with takeover isolation" ON public."messages"
  USING (((NOT is_banned()) AND (is_admin() OR (EXISTS ( SELECT 1
   FROM matches
  WHERE ((matches.id = messages.match_id) AND ((SELECT auth.uid()) = ANY (matches.participants))))) OR (EXISTS ( SELECT 1
   FROM matches
  WHERE ((matches.id = messages.match_id) AND (matches.takeover_target = (SELECT auth.uid())) AND (messages.created_at <= matches.takeover_at)))))));

ALTER POLICY "Tunnel sender inserts current or recently ended messages" ON public."messages"
  WITH CHECK (((NOT ( SELECT is_banned() AS is_banned)) AND (sender_id = ( SELECT (SELECT auth.uid()) AS uid)) AND (((type)::text = ANY ((ARRAY['text'::character varying, 'image'::character varying])::text[])) OR (( SELECT is_admin() AS is_admin) AND ((type)::text = 'system'::text))) AND (EXISTS ( SELECT 1
   FROM matches m
  WHERE ((m.id = messages.match_id) AND (((m.is_active = true) AND (( SELECT is_admin() AS is_admin) OR ((( SELECT (SELECT auth.uid()) AS uid) = ANY (m.participants)) AND ((NOT COALESCE(m.is_taken_over, false)) OR (m.takeover_target IS DISTINCT FROM ( SELECT (SELECT auth.uid()) AS uid)))))) OR ((m.is_active = false) AND ((m.ended_reason)::text = 'user_left'::text) AND (COALESCE(m.is_taken_over, false) = false) AND (m.ended_at > (now() - '24:00:00'::interval)) AND (( SELECT (SELECT auth.uid()) AS uid) = ANY (m.participants)))))))));

ALTER POLICY "Everyone can view profiles" ON public."profiles"
  USING (((( SELECT (SELECT auth.uid()) AS uid) = id) OR is_admin()));

ALTER POLICY "Users can insert own profile" ON public."profiles"
  WITH CHECK ((((SELECT auth.uid()) = id) AND ((role)::text = 'user'::text)));

ALTER POLICY "Users can update own profile" ON public."profiles"
  USING (((((SELECT auth.uid()) = id) AND (NOT is_banned())) OR is_admin()))
  WITH CHECK (((((SELECT auth.uid()) = id) AND ((role)::text = 'user'::text)) OR is_admin()));

ALTER POLICY "Tunnel participants create own signals" ON public."tunnel_webrtc_signals"
  WITH CHECK (((NOT is_banned()) AND (sender_id = (SELECT auth.uid())) AND (EXISTS ( SELECT 1
   FROM matches m
  WHERE ((m.id = tunnel_webrtc_signals.match_id) AND (m.is_active = true) AND ((SELECT auth.uid()) = ANY (m.participants)))))));

ALTER POLICY "Tunnel participants read signals" ON public."tunnel_webrtc_signals"
  USING (((NOT is_banned()) AND (EXISTS ( SELECT 1
   FROM matches m
  WHERE ((m.id = tunnel_webrtc_signals.match_id) AND (m.is_active = true) AND ((SELECT auth.uid()) = ANY (m.participants)))))));

ALTER POLICY "Tunnel participants remove own signal" ON public."tunnel_webrtc_signals"
  USING (((sender_id = ( SELECT (SELECT auth.uid()) AS uid)) AND (NOT ( SELECT is_banned() AS is_banned)) AND (EXISTS ( SELECT 1
   FROM matches m
  WHERE ((m.id = tunnel_webrtc_signals.match_id) AND (m.is_active = true) AND (( SELECT (SELECT auth.uid()) AS uid) = ANY (m.participants)))))));

ALTER POLICY "Tunnel participants replace own signals" ON public."tunnel_webrtc_signals"
  USING (((sender_id = (SELECT auth.uid())) AND (NOT is_banned()) AND (EXISTS ( SELECT 1
   FROM matches m
  WHERE ((m.id = tunnel_webrtc_signals.match_id) AND (m.is_active = true) AND ((SELECT auth.uid()) = ANY (m.participants)))))))
  WITH CHECK (((sender_id = (SELECT auth.uid())) AND (NOT is_banned()) AND (EXISTS ( SELECT 1
   FROM matches m
  WHERE ((m.id = tunnel_webrtc_signals.match_id) AND (m.is_active = true) AND ((SELECT auth.uid()) = ANY (m.participants)))))));
