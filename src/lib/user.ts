import type { User } from '@supabase/supabase-js';
import { assertSupabaseConfigured, supabase } from './supabase';

let initialization: Promise<User> | null = null;

export async function ensureUser(): Promise<User> {
  assertSupabaseConfigured();

  if (!initialization) {
    initialization = (async () => {
      // Use getUser() instead of getSession() to validate the session against the server
      let currentUser = null;
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      
      if (user) {
        currentUser = user;
      } else {
        // If there's an error (e.g., user was deleted from the database but session remains locally), clear it.
        if (userError) {
          await supabase.auth.signOut();
        }

        // A missing/expired session is the normal first-visit state. Calling
        // signOut here causes Supabase to return AuthSessionMissingError and can
        // race with another component that is establishing the anonymous user.
        const { data, error } = await supabase.auth.signInAnonymously();
        if (error) {
          throw new Error(`匿名登入失敗：${error.message}。請確認 Supabase 已啟用 Anonymous Sign-Ins。`);
        }
        if (!data.user) throw new Error('匿名登入未回傳使用者資料。');
        currentUser = data.user;
      }

      // Ensure the profile row exists to prevent foreign key errors during matching
      const { error: upsertError } = await supabase.from('profiles').upsert(
        { id: currentUser.id, status: 'online' },
        { onConflict: 'id' }
      );
      if (upsertError) {
        console.warn('Profile upsert failed (might not be an issue if RLS is tight):', upsertError);
      }

      return currentUser;
    })().finally(() => {
      initialization = null;
    });
  }

  return initialization;
}

export async function getUserId(): Promise<string> {
  return (await ensureUser()).id;
}
