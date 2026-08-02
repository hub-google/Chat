import { createClient } from '@supabase/supabase-js';
import { env, getPublicEnvError } from './env';

export const supabaseConfigError = getPublicEnvError();

export const supabase = createClient(
  env.SUPABASE_URL || 'https://configuration.invalid',
  env.SUPABASE_ANON_KEY || 'configuration-missing',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);

export function assertSupabaseConfigured() {
  if (supabaseConfigError) throw new Error(supabaseConfigError);
}
