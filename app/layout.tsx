import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'The Room Remembers You',
  description: 'An offline, privacy-preserving interactive art installation.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
