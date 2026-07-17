import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Printify Studio',
  description: 'Upload one photo. See it on every product.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-neutral-900 antialiased">
        {children}
      </body>
    </html>
  );
}
