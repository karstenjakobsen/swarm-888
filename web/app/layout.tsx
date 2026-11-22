import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-500.css'
import '@fontsource/ibm-plex-sans/latin-600.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import { operatorMode } from '@/lib/operator/mode'
import { OperatorProvider } from '@/components/operator/store'
import './globals.css'

export const dynamic = 'force-dynamic'

export function generateMetadata(): Metadata {
  return {
    title: operatorMode() === 'live' ? 'Private operator' : 'Operator · vps-fra-1',
    description: 'What your VPS operator did, whether the server is as you asked, and what needs you.',
    generator: 'v0.app',
    manifest: operatorMode() === 'demo' ? '/manifest.json' : undefined,
    appleWebApp: { capable: true, title: 'Operator', statusBarStyle: 'black-translucent' },
    icons: {
      icon: [
        { url: '/icon-light-32x32.png', media: '(prefers-color-scheme: light)' },
        { url: '/icon-dark-32x32.png', media: '(prefers-color-scheme: dark)' },
        { url: '/icon.svg', type: 'image/svg+xml' },
      ],
      apple: '/apple-icon.png',
    },
  }
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3f4f7' },
    { media: '(prefers-color-scheme: dark)', color: '#171b22' },
  ],
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const mode = operatorMode()
  return (
    <html lang="en" className="bg-background">
      <body className="min-h-dvh antialiased">
        <OperatorProvider mode={mode}>{children}</OperatorProvider>
        {mode === 'demo' && process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
