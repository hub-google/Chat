-- Single RLS-respecting check for moderation + chat room state.
CREATE OR REPLACE FUNCTION public.tunnel_room_control(p_match_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'allowed', public.tunnel_access_allowed(),
    'is_active', room.is_active,
    'is_taken_over', room.is_taken_over,
    'takeover_target', room.takeover_target
  )
  FROM (SELECT 1) driver
  LEFT JOIN LATERAL (
    SELECT m.is_active, m.is_taken_over, m.takeover_target
    FROM public.matches m WHERE m.id = p_match_id
  ) room ON true;
$$;
REVOKE ALL ON FUNCTION public.tunnel_room_control(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tunnel_room_control(uuid) TO authenticated;
