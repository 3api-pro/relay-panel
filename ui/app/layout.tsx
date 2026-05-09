import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '3API Panel',
  description: 'Open-source AI API reseller platform with built-in upstream',
};

export default function RootLayout({
  children,
}: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
