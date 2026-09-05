import type { MetadataRoute } from 'next'

/**
 * Installable metadata.
 *
 * Present so the app can be pinned to a dock, taskbar or home screen and keep
 * its own icon there rather than a screenshot of the page.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'HisaabhKitaabh',
    short_name: 'HisaabhKitaabh',
    description: 'Folders, files, rows. An expense ledger that stays out of your way.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0b0c0f',
    theme_color: '#0b0c0f',
    icons: [
      { src: '/logo-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/logo-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  }
}
