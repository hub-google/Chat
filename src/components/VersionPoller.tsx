'use client';

import { useEffect } from 'react';

export function VersionPoller() {
  useEffect(() => {
    // Poll every 5 minutes to check for new version deployment
    const interval = setInterval(async () => {
      try {
         // We attempt to fetch the build ID from Next.js generated static files
         // or a specific version endpoint. Here we fallback to checking the root page headers.
         const res = await fetch('/', { method: 'HEAD', cache: 'no-store' });
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
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').then(
          (registration) => {
            console.log('ServiceWorker registration successful with scope: ', registration.scope);
          },
          (err) => {
            console.log('ServiceWorker registration failed: ', err);
          }
        );
      });
    }
  }, []);

  return null;
}
