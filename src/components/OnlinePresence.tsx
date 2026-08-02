'use client';
import { useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { getUserId } from '../lib/user';

export function OnlinePresence() {
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let active = true;
    void getUserId().then((userId) => {
      if (!active) return;
      channel = supabase.channel('site_online', { config: { presence: { key: userId } } });
      channel.on('presence', { event: 'sync' }, () => {
        const count = Object.keys(channel?.presenceState() ?? {}).length;
        document.documentElement.dataset.onlineCount = String(count);
        window.dispatchEvent(new CustomEvent('site-online-count', { detail: count }));
      });
      channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') await channel?.track({ userId, onlineAt: new Date().toISOString() });
      });
    }).catch(() => {});
    return () => { active = false; if (channel) void supabase.removeChannel(channel); };
  }, []);
  return null;
}
