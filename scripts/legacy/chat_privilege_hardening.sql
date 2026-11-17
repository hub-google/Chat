ALTER FUNCTION public.terminate_match_by_admin(uuid,text) SET search_path = public;
ALTER FUNCTION public.admin_takeover_session(uuid,uuid,text) SET search_path = public;
ALTER FUNCTION public.haversine_distance(double precision,double precision,double precision,double precision) SET search_path = public;
ALTER FUNCTION public.purge_archived_messages() SET search_path = public;
REVOKE ALL ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_admin(), public.is_banned() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin(), public.is_banned() TO authenticated;
REVOKE ALL ON public.profiles, public.matches, public.messages, public.matching_pool, public.chat_reports, public.admin_takeovers, public.topic_cards, public.topic_categories FROM anon;
