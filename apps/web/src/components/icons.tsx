/**
 * Custom inline SVG icon set (candy-premium pass) — filled, gradient-lit,
 * dark-rimmed 24×24 glyphs matching the Ludo-Club-style art direction.
 * Gradient ids are per-icon constants: duplicate ids across instances of the
 * same icon resolve to identical defs, which is safe.
 */
import type { ReactNode } from 'react';

function Svg({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`icon${className ? ` ${className}` : ''}`} aria-hidden="true">
      {children}
    </svg>
  );
}

/** Legacy stroke frame — kept for the toolbar glyphs that sit on the blue stage. */
function I({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`icon${className ? ` ${className}` : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconTrophy({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <defs>
        <linearGradient id="ig-cup" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffe27a" />
          <stop offset="55%" stopColor="#f5b301" />
          <stop offset="100%" stopColor="#d99a00" />
        </linearGradient>
      </defs>
      <path
        d="M5 4.6H3.4a2.4 2.4 0 0 0 0 4.8h2"
        fill="none"
        stroke="#d99a00"
        strokeWidth={1.7}
        strokeLinecap="round"
      />
      <path
        d="M19 4.6h1.6a2.4 2.4 0 0 1 0 4.8h-2"
        fill="none"
        stroke="#d99a00"
        strokeWidth={1.7}
        strokeLinecap="round"
      />
      <path
        d="M5 2.6h14v6.6a7 7 0 0 1-14 0Z"
        fill="url(#ig-cup)"
        stroke="#b57e00"
        strokeWidth={1}
        strokeLinejoin="round"
      />
      <ellipse cx={9.4} cy={5.6} rx={2} ry={1.1} fill="#ffffff" opacity={0.5} transform="rotate(-18 9.4 5.6)" />
      <path d="M10.6 15.8h2.8v2.6h-2.8z" fill="#d99a00" />
      <path
        d="M8.2 18.4h7.6a1.4 1.4 0 0 1 1.4 1.4v1.4H6.8v-1.4a1.4 1.4 0 0 1 1.4-1.4Z"
        fill="url(#ig-cup)"
        stroke="#b57e00"
        strokeWidth={0.9}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function IconUsers({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <defs>
        <linearGradient id="ig-uback" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8ee06b" />
          <stop offset="100%" stopColor="#46a758" />
        </linearGradient>
        <linearGradient id="ig-ufront" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7fa4f4" />
          <stop offset="100%" stopColor="#3e63dd" />
        </linearGradient>
      </defs>
      <circle cx={16.2} cy={8} r={3.1} fill="url(#ig-uback)" stroke="#2e7a3c" strokeWidth={0.8} />
      <path
        d="M14.6 13.1a5 5 0 0 1 6.6 4.8v1h-5.4"
        fill="url(#ig-uback)"
        stroke="#2e7a3c"
        strokeWidth={0.8}
        strokeLinejoin="round"
      />
      <circle cx={9} cy={7.4} r={3.9} fill="url(#ig-ufront)" stroke="#2947a8" strokeWidth={0.9} />
      <path
        d="M9 12.6a5.8 5.8 0 0 1 5.8 5.8v.6H3.2v-.6A5.8 5.8 0 0 1 9 12.6Z"
        fill="url(#ig-ufront)"
        stroke="#2947a8"
        strokeWidth={0.9}
        strokeLinejoin="round"
      />
      <ellipse cx={7.6} cy={5.9} rx={1.3} ry={0.8} fill="#ffffff" opacity={0.55} transform="rotate(-24 7.6 5.9)" />
    </Svg>
  );
}

export function IconFlame({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <defs>
        <linearGradient id="ig-flame" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffb03a" />
          <stop offset="100%" stopColor="#f4511e" />
        </linearGradient>
        <linearGradient id="ig-fcore" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffe27a" />
          <stop offset="100%" stopColor="#ffb300" />
        </linearGradient>
      </defs>
      <path
        d="M12 2.2c.6 2.6-.2 4.2 1 6.1.7 1.1 1.7 1.9 2.6 3 1 1.3 1.7 2.8 1.7 4.5 0 3.6-2.4 6-5.3 6s-5.3-2.4-5.3-6c0-2.4 1.2-4.2 2.4-5.8.4 1 1.1 1.7 2 1.9-.8-2.8-.9-6.4.9-9.7Z"
        fill="url(#ig-flame)"
        stroke="#c93d12"
        strokeWidth={0.9}
        strokeLinejoin="round"
      />
      <path
        d="M12 11.4c1.4 1.5 2.4 2.7 2.4 4.6 0 2.2-1.1 3.7-2.4 4.2-1.3-.5-2.4-2-2.4-4.2 0-1.9 1-3.1 2.4-4.6Z"
        fill="url(#ig-fcore)"
      />
    </Svg>
  );
}

export function IconTicket({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <defs>
        <linearGradient id="ig-ticket" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffd54f" />
          <stop offset="100%" stopColor="#f5a301" />
        </linearGradient>
      </defs>
      <path
        d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1.3a2.7 2.7 0 0 0 0 5.4V16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1.3a2.7 2.7 0 0 0 0-5.4Z"
        fill="url(#ig-ticket)"
        stroke="#c98f00"
        strokeWidth={1}
        strokeLinejoin="round"
      />
      <line x1={15} y1={7.6} x2={15} y2={16.4} stroke="#ffffff" strokeWidth={1.2} strokeDasharray="1.7 1.7" opacity={0.85} />
      <ellipse cx={8} cy={9} rx={2.4} ry={1.1} fill="#ffffff" opacity={0.4} transform="rotate(-16 8 9)" />
    </Svg>
  );
}

export function IconTarget({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <defs>
        <linearGradient id="ig-target" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f1655a" />
          <stop offset="100%" stopColor="#d23f3f" />
        </linearGradient>
      </defs>
      <circle cx={12} cy={12} r={9.5} fill="url(#ig-target)" stroke="#b02e33" strokeWidth={0.9} />
      <circle cx={12} cy={12} r={6.7} fill="#ffffff" />
      <circle cx={12} cy={12} r={4.1} fill="url(#ig-target)" />
      <circle cx={12} cy={12} r={1.6} fill="#ffffff" />
      <ellipse cx={8.4} cy={7} rx={2.4} ry={1.2} fill="#ffffff" opacity={0.4} transform="rotate(-32 8.4 7)" />
    </Svg>
  );
}

export function IconShield({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <defs>
        <linearGradient id="ig-shield" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#5fcb68" />
          <stop offset="100%" stopColor="#2e9e6b" />
        </linearGradient>
      </defs>
      <path
        d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
        fill="url(#ig-shield)"
        stroke="#1e6b45"
        strokeWidth={0.9}
      />
      <path
        d="m8.4 12.1 2.5 2.5 4.7-5"
        fill="none"
        stroke="#ffffff"
        strokeWidth={2.1}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function IconMenu({ className }: { className?: string }) {
  return (
    <I className={className}>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </I>
  );
}

export function IconSoundOn({ className }: { className?: string }) {
  return (
    <I className={className}>
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </I>
  );
}

export function IconSoundOff({ className }: { className?: string }) {
  return (
    <I className={className}>
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="M22 9l-6 6" />
      <path d="M16 9l6 6" />
    </I>
  );
}
