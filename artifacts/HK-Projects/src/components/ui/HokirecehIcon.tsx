interface HokirecehIconProps {
  size?: number;
  className?: string;
}

export function HokirecehIcon({ size = 32, className }: HokirecehIconProps) {
  const id = "hoki-g";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5dd3c4" />
          <stop offset="100%" stopColor="#1f8c7a" />
        </linearGradient>
      </defs>

      {/* Glitch pixel fragments — top-left corner */}
      <rect x="3"  y="15" width="8"  height="11" rx="2" fill={`url(#${id})`} opacity="0.55" />
      <rect x="13" y="4"  width="7"  height="9"  rx="2" fill={`url(#${id})`} opacity="0.40" />
      <rect x="3"  y="29" width="5"  height="5"  rx="1" fill={`url(#${id})`} opacity="0.28" />
      <rect x="12" y="17" width="5"  height="7"  rx="1" fill={`url(#${id})`} opacity="0.50" />

      {/* Main rounded square body */}
      <rect x="21" y="19" width="72" height="72" rx="15" fill={`url(#${id})`} />

      {/* Inner border square */}
      <rect x="33" y="31" width="48" height="48" rx="9"
        stroke="rgba(255,255,255,0.42)" strokeWidth="3.5" />

      {/* Inner symbol — vertical bar + 3 horizontal bars (like a stylised B / circuit) */}
      <rect x="41" y="38" width="4"  height="27" rx="2" fill="rgba(255,255,255,0.65)" />
      <rect x="41" y="38" width="22" height="4"  rx="2" fill="rgba(255,255,255,0.65)" />
      <rect x="41" y="50" width="18" height="4"  rx="2" fill="rgba(255,255,255,0.65)" />
      <rect x="41" y="61" width="22" height="4"  rx="2" fill="rgba(255,255,255,0.65)" />
    </svg>
  );
}
