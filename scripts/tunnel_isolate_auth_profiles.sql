-- One-time shared-project isolation fix. Existing users/profiles are retained.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_auth_user();
