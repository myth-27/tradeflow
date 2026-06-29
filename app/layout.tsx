import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TradeFlow — AI Crypto Analysis',
  description: 'Real-time crypto price action analysis powered by GPT-4o',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-bg-900 text-gray-100 antialiased m-0 p-0">
        {children}
      </body>
    </html>
  );
}
