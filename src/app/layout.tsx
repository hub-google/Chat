import type { Metadata } from 'next';
import './globals.css';
import { VersionPoller } from '../components/VersionPoller';
import { OnlinePresence } from '../components/OnlinePresence';

export const metadata: Metadata = {
  title: 'Tunnel - Anonymous Chat',
  description: 'A highly performant anonymous chatting experience.',
  manifest: '/manifest.json',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-TW">
      <body>
        <VersionPoller />
        <OnlinePresence />
        {children}
      </body>
    </html>
  );
}
