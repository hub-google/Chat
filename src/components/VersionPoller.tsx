'use client';

import { useEffect } from 'react';

export function VersionPoller() {
  useEffect(() => {
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
    // Poll every 5 minutes to check for new version deployment
    const interval = setInterval(async () => {
      try {
         // We attempt to fetch the build ID from Next.js generated static files
         // or a specific version endpoint. Here we fallback to checking the root page headers.
         const res = await fetch(`${basePath}/`, { method: 'HEAD', cache: 'no-store' });
         if (!res.ok) return;
         const etag = res.headers.get('etag');
         if (etag) {
           const currentEtag = localStorage.getItem('app_etag');
           if (currentEtag && currentEtag !== etag) {
             window.location.reload(); // Force reload if version changes
           } else {
             localStorage.setItem('app_etag', etag);
           }
         }
      } catch (e) {
         // ignore network errors for polling
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
