import type { Metadata, Viewport } from 'next'
import './globals.css'
import { Toaster } from '@/components/ui/Toast'

export const metadata: Metadata = {
  title: 'HisaabKitaab — expense ledger',
  description: 'Folders, files, rows. Track what you spend without fighting a spreadsheet.',
  applicationName: 'HisaabKitaab',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'HisaabKitaab' },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom stays available — disabling it breaks the app for anyone who needs it.
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f9f8f6' },
    { media: '(prefers-color-scheme: dark)', color: '#101114' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applied before first paint so a dark-theme user never sees a white flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('hisaabkitaab-theme');if(t&&t!=='system')document.documentElement.setAttribute('data-theme',t)}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-full antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  )
}
