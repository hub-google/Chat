-- Limit profile rows to their owner/admin; expose only four fields to a peer.
CREATE SCHEMA IF NOT EXISTS chat_api_private;
REVOKE ALL ON SCHEMA chat_api_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA chat_api_private TO authenticated;
ALTER POLICY "Everyone can view profiles" ON public.profiles
  USING ((select auth.uid()) = id OR public.is_admin());
CREATE OR REPLACE FUNCTION chat_api_private.get_peer_profile(p_match_id uuid)
RETURNS TABLE(gender varchar, age integer, city varchar, bio text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p.gender, p.age, p.city, p.bio
  FROM public.matches m JOIN public.profiles p ON p.id = ANY(m.participants)
  WHERE m.id = p_match_id AND auth.uid() IS NOT NULL
    AND auth.uid() = ANY(m.participants) AND p.id <> auth.uid()
    AND NOT public.is_banned()
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION chat_api_private.get_peer_profile(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat_api_private.get_peer_profile(uuid) TO authenticated;
CREATE OR REPLACE FUNCTION public.get_peer_profile(p_match_id uuid)
RETURNS TABLE(gender varchar, age integer, city varchar, bio text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM chat_api_private.get_peer_profile(p_match_id); $$;
REVOKE ALL ON FUNCTION public.get_peer_profile(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_peer_profile(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';
