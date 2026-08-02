'use client';

import React, { useEffect, useState } from 'react';
import { UserHUD } from '../components/UserHUD';
import { ChatWindow } from '../components/ChatWindow';
import { ensureUser } from '../lib/user';

export default function Home() {
  const [authState, setAuthState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [authError, setAuthError] = useState('');

  useEffect(() => {
    let active = true;
    ensureUser()
      .then(() => active && setAuthState('ready'))
      .catch((error: unknown) => {
        if (!active) return;
        setAuthError(error instanceof Error ? error.message : '無法初始化匿名身分。');
        setAuthState('error');
      });
    return () => { active = false; };
  }, []);

  if (authState !== 'ready') {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div role={authState === 'error' ? 'alert' : 'status'} style={{ maxWidth: 520, textAlign: 'center' }}>
          <h1>Tunnel</h1>
          <p>{authState === 'loading' ? '正在建立安全匿名連線…' : authError}</p>
          {authState === 'error' && (
            <button onClick={() => window.location.reload()} style={{ padding: '10px 18px', cursor: 'pointer' }}>
              重新連線
            </button>
          )}
        </div>
      </main>
    );
  }

  return (
    <main style={{ minHeight: '100vh', background: 'var(--color-surface-light)' }}>
      <UserHUD />
      <ChatWindow />
    </main>
  );
}
