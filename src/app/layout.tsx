import type { Metadata, Viewport } from 'next'
import { Analytics } from '@vercel/analytics/next'
import { SpeedInsights } from '@vercel/speed-insights/next'
import './globals.css'
import { Toaster } from '@/components/ui/Toast'

export const metadata: Metadata = {
  title: 'HisaabhKitaabh',
  description: 'Folders, files, rows. Track what you spend without fighting a spreadsheet.',
  applicationName: 'HisaabhKitaabh',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'HisaabhKitaabh' },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom stays available - disabling it breaks the app for anyone who needs it.
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
            // Theme and brightness are applied before the first paint. Doing
            // either in React would show a white flash and then dim it, which
            // is worse than not offering the setting at all.
            __html: `try{var d=document.documentElement,t=localStorage.getItem('hisaabhkitaabh-theme');if(t&&t!=='system')d.setAttribute('data-theme',t);var lit=t==='light'||(t!=='dark'&&!matchMedia('(prefers-color-scheme: dark)').matches),b=parseFloat(localStorage.getItem('hisaabhkitaabh-brightness'));if(lit&&b>0&&b<1){b=Math.max(0.62,b);var P={bg:[249,248,246],surface:[255,255,255],raised:[244,243,240],line:[226,224,219],'accent-soft':[232,240,252]};for(var k in P)d.style.setProperty('--'+k,P[k].map(function(c){return Math.round(26+(c-26)*b)}).join(' '))}}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-full antialiased">
        {children}
        <Toaster />
        {/* Both are inert off Vercel: the scripts are only served by the
            platform, so local development and any other host see nothing. */}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  )
}
