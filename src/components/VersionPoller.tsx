'use client';

import { useEffect } from 'react';
import { useMatchStore } from '../store/matchStore';

export function VersionPoller() {
  useEffect(() => {
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
    const etagKey = `tunnel:etag:${basePath || '/'}`;
    // Never refresh a matched or queued user: deployment must not interrupt
    // an ongoing P2P room. Apply version changes only after returning to lobby.
    const interval = setInterval(async () => {
      if (useMatchStore.getState().status !== 'idle') return;
      try {
        const res = await fetch(`${basePath}/`, { method: 'HEAD', cache: 'no-store' });
        if (!res.ok) return;
        const etag = res.headers.get('etag');
        if (!etag) return;
        const currentEtag = localStorage.getItem(etagKey);
        if (currentEtag && currentEtag !== etag) {
          // A second status check protects against a match that started while
          // the HEAD request was in flight.
          if (useMatchStore.getState().status !== 'idle') return;
          localStorage.setItem(etagKey, etag);
          window.location.reload();
        } else {
          localStorage.setItem(etagKey, etag);
        }
      } catch {
        // A failed version check must never interrupt chat.
      }
    }, 5 * 60 * 1000);
    
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      const register = () => {
        const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
        navigator.serviceWorker.register(`${basePath}/sw.js`, { scope: `${basePath}/` }).then(
          (registration) => {
            console.log('ServiceWorker registration successful with scope: ', registration.scope);
          },
          (err) => {
            console.log('ServiceWorker registration failed: ', err);
          }
        );
      };
      if (document.readyState === 'complete') register();
      else window.addEventListener('load', register, { once: true });
      return () => window.removeEventListener('load', register);
    }
  }, []);

  return null;
}
