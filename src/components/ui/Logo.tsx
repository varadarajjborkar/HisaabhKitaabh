/**
 * The mark.
 *
 * One raster asset at three sizes, served from /public so it is cached by the
 * CDN and never re-encoded per render. The tile is dark on purpose: the artwork
 * is drawn for a dark ground, so it keeps its own background instead of
 * inheriting the page's and losing contrast in light mode.
 */
export function Logo({ size = 32, className = '' }: { size?: number; className?: string }) {
  const radius = Math.round(size * 0.26)
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logo-192.png"
      alt=""
      width={size}
      height={size}
      className={`shrink-0 object-cover bg-[#121b2f] ${className}`}
      style={{ width: size, height: size, borderRadius: radius }}
      draggable={false}
    />
  )
}

/** Mark plus name, the lockup used in headers. */
