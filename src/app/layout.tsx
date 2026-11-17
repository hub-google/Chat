import type { Metadata } from 'next';
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
        <VersionPoller />
        <OutboxRecovery />
        {children}
      </body>
    </html>
  );
}
