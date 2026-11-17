-- Protect role, admin_until, reputation_score from browser-controlled updates.
REVOKE INSERT, UPDATE ON public.profiles FROM authenticated;
GRANT INSERT (id) ON public.profiles TO authenticated;
GRANT UPDATE (
 nickname, gender, age, city, job, bio, opening_message, lat, lng,
 location_updated_at, device_fingerprint, last_ip, last_ip_location_zh,
 status, updated_at
) ON public.profiles TO authenticated;
