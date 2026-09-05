/**
 * Hand-drawn icon set.
 *
 * A dozen 1.6px-stroke glyphs weigh less than a kilobyte and share one visual
 * language; an icon package would ship thousands and still not match. All of
 * them inherit `currentColor` and size from the parent's font-size.
 */
type P = { className?: string; size?: number }

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
})

export const Icon = {
  Back: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M15 18l-6-6 6-6" /></svg>
  ),
  Chevron: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M9 6l6 6-6 6" /></svg>
  ),
  Down: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M6 9l6 6 6-6" /></svg>
  ),
  Plus: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M12 5v14M5 12h14" /></svg>
  ),
  Close: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M18 6L6 18M6 6l12 12" /></svg>
  ),
  Folder: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M3 7a2 2 0 012-2h3.9a2 2 0 011.6.8l.9 1.2H19a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>
  ),
  File: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" /><path d="M14 3v5h5" /></svg>
  ),
  Trash: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m2 0v12a2 2 0 01-2 2H9a2 2 0 01-2-2V7" /><path d="M10 11v6M14 11v6" /></svg>
  ),
  Undo: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 010 10h-4" /></svg>
  ),
  Redo: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 000 10h4" /></svg>
  ),
  /*
   * A single circular arrow, open at the top and travelling anticlockwise.
   *
   * The old glyph drew a three-quarter arc plus a separate corner bracket that
   * met it nowhere near tangentially, so at 15px it read as a broken ring with
   * a tick stuck to it. Two things fix that. The head sits exactly on the arc's
   * own endpoint, where a circle's tangent is horizontal, so the arrow points
   * along the path it is describing. And it is a filled triangle rather than
   * two hairlines: at a 17px render a 1.6px stroke chevron collapses into the
   * arc it is attached to, while a solid wedge stays a wedge.
   */
  Refresh: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}>
      <path d="M12 4.8A7.2 7.2 0 1 0 18.2 8.4" />
      <path d="M12 4.8L16.5 2.3v5z" fill="currentColor" stroke="none" />
    </svg>
  ),
  Sun: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </svg>
  ),
  Moon: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M20 14.2A8.2 8.2 0 019.8 4 8.4 8.4 0 1020 14.2z" /></svg>
  ),
  Monitor: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M9 20h6M12 16.5V20" /></svg>
  ),
  Pencil: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M4 20h4L19.5 8.5a2.1 2.1 0 00-3-3L5 17v3z" /><path d="M14.5 6.5l3 3" /></svg>
  ),
  Eye: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></svg>
  ),
  EyeOff: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}>
      <path d="M10.6 6.7A8.7 8.7 0 0112 6.5c6 0 9.5 6.5 9.5 6.5a17 17 0 01-3 3.7M6.3 8.1A17.4 17.4 0 002.5 13S6 19.5 12 19.5a8.9 8.9 0 003.4-.66" />
      <path d="M9.9 10.4a3 3 0 004.2 4.2" />
      <path d="M3.5 3.5l17 17" />
    </svg>
  ),
  History: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M3.5 12a8.5 8.5 0 10.9-3.8" /><path d="M3.5 4.5v4h4" /><path d="M12 7.5V12l3 1.8" /></svg>
  ),
  /* Vertical dots: "more actions here". Distinct from Grip, which is a handle
     you can actually pull. Using one glyph for both taught the wrong gesture. */
  More: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  ),
  Columns: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9.5 4.5v15M15 4.5v15" /></svg>
  ),
  Calendar: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" /></svg>
  ),
  Upload: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M12 16V5M8 9l4-4 4 4" /><path d="M4 19h16" /></svg>
  ),
  Save: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M5 4h11l3 3v13a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z" /><path d="M8 4v5h7M8 15h8" /></svg>
  ),
  Download: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M12 4v11M7 11l5 5 5-5" /><path d="M4 19h16" /></svg>
  ),
  Copy: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 012-2h8" /></svg>
  ),
  Mail: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 7l8.5 6 8.5-6" /></svg>
  ),
  Sparkle: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" /><path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z" /></svg>
  ),
  Chart: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>
  ),
  Calculator: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M8 7h8M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 16h.01M12 16h.01M15.5 16h3" /></svg>
  ),
  Search: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></svg>
  ),
  Filter: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M3 5h18l-7 8v6l-4-2v-4L3 5z" /></svg>
  ),
  Sort: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M7 4v16M7 20l-3-3M7 4l3 3M17 20V4M17 4l3 3M17 20l-3-3" /></svg>
  ),
  Check: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M5 12.5l4.5 4.5L19 7" /></svg>
  ),
  Attach: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M20 11l-8.5 8.5a5 5 0 01-7-7L13 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 6" /></svg>
  ),
  Logout: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M15 17l5-5-5-5" /><path d="M20 12H9M12 20H6a2 2 0 01-2-2V6a2 2 0 012-2h6" /></svg>
  ),
  Google: ({ size = 18, className }: P) => (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <path fill="#4285F4" d="M23 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.2a5.3 5.3 0 01-2.3 3.5v2.9h3.7c2.2-2 3.4-5 3.4-8.6z" />
      <path fill="#34A853" d="M12 23.5c3.1 0 5.7-1 7.6-2.8l-3.7-2.9c-1 .7-2.3 1.1-3.9 1.1-3 0-5.5-2-6.4-4.7H1.8v3a11.5 11.5 0 0010.2 6.3z" />
      <path fill="#FBBC05" d="M5.6 14.2a6.9 6.9 0 010-4.4v-3H1.8a11.5 11.5 0 000 10.4l3.8-3z" />
      <path fill="#EA4335" d="M12 4.8c1.7 0 3.2.6 4.4 1.7l3.3-3.3A11.5 11.5 0 001.8 6.8l3.8 3C6.5 6.8 9 4.8 12 4.8z" />
    </svg>
  ),
  Spinner: ({ size = 16, className }: P) => (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`animate-spin ${className ?? ''}`} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.4" fill="none" opacity=".2" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinecap="round" />
    </svg>
  ),
  Warning: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M12 4l9 15.5H3L12 4z" /><path d="M12 10v4M12 17h.01" /></svg>
  ),
  Drive: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M9 3h6l6 10.5H15L9 3z" /><path d="M3 20.5L9 10l3 5.2-3 5.3H3z" /><path d="M9 20.5h12l-3-5.2H12" /></svg>
  ),
  Menu: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
  ),
  Grip: ({ size = 18, className }: P) => (
    <svg {...base(size)} className={className}><circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none" /><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none" /><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none" /><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none" /></svg>
  ),
}
