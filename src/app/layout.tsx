import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';
import { VersionPoller } from '../components/VersionPoller';
import { OutboxRecovery } from '../components/OutboxRecovery';

export const metadata: Metadata = {
  title: 'Tunnel - Anonymous Chat',
  description: 'A highly performant anonymous chatting experience.',
  manifest: `${process.env.NEXT_PUBLIC_BASE_PATH || ''}/manifest.json`,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-TW">
      <body>
        <Script id="chat-canonical-host" strategy="beforeInteractive">{`
          (() => {
            const hostname = window.location.hostname.toLowerCase();
            if (hostname !== 'hub-google.github.io' &&
                hostname !== 'monsterport-chat.pages.dev' &&
                !hostname.endsWith('.monsterport-chat.pages.dev')) return;
            const path = window.location.pathname;
            const cleanPath = hostname === 'hub-google.github.io' && (path === '/Chat' || path.startsWith('/Chat/'))
              ? (path.slice(5) || '/')
              : path;
            const canonical = new URL('https://chat.monsterport.com');
            canonical.pathname = cleanPath;
            canonical.search = window.location.search;
            canonical.hash = window.location.hash;
            window.location.replace(canonical.href);
          })();
        `}</Script>
        <VersionPoller />
        <OutboxRecovery />
        {children}
      </body>
    </html>
  );
}
