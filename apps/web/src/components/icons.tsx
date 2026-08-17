/**
 * Custom inline SVG icon set (candy-premium pass) — filled, gradient-lit,
 * dark-rimmed 24×24 glyphs matching the Ludo-Club-style art direction.
 * Gradient ids are per-icon constants: duplicate ids across instances of the
 * same icon resolve to identical defs, which is safe.
 */
import type { ReactNode } from 'react';

function Svg({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`icon${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    >
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
      <ellipse
        cx={9.4}
        cy={5.6}
        rx={2}
        ry={1.1}
        fill="#ffffff"
        opacity={0.5}
        transform="rotate(-18 9.4 5.6)"
      />
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
      <ellipse
        cx={7.6}
        cy={5.9}
        rx={1.3}
        ry={0.8}
        fill="#ffffff"
        opacity={0.55}
        transform="rotate(-24 7.6 5.9)"
      />
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
      <line
        x1={15}
        y1={7.6}
        x2={15}
        y2={16.4}
        stroke="#ffffff"
        strokeWidth={1.2}
        strokeDasharray="1.7 1.7"
        opacity={0.85}
      />
      <ellipse
        cx={8}
        cy={9}
        rx={2.4}
        ry={1.1}
        fill="#ffffff"
        opacity={0.4}
        transform="rotate(-16 8 9)"
      />
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
      <ellipse
        cx={8.4}
        cy={7}
        rx={2.4}
        ry={1.2}
        fill="#ffffff"
        opacity={0.4}
        transform="rotate(-32 8.4 7)"
      />
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

/**
 * Organic pass — the redesign replaces every emoji and every gradient-filled
 * candy glyph with a line icon. These are vendored from Lucide (ISC licence,
 * https://github.com/lucide-icons/lucide) rather than pulled from a CDN: rule 4
 * in AGENTS.md caps the critical path at 300 KB gzipped and forbids a new UI
 * dependency, and inline SVG is the house rule for images. Paths are copied
 * verbatim from lucide-icons/lucide@main so they stay diffable upstream.
 *
 * Stroke width is 2.75, not Lucide's default 2 — at the 14–21 px sizes the
 * design uses, 2 goes thin and grey against the cream ground.
 */
function L({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`icon${className ? ` ${className}` : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconBatteryFull({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M10 10v4" />
      <path d="M14 10v4" />
      <path d="M22 14v-4" />
      <path d="M6 10v4" />
      <rect x="2" y="6" width="16" height="12" rx="2" />
    </L>
  );
}

export function IconBell({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
    </L>
  );
}

export function IconBookOpen({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M12 5v16" />
      <path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z" />
    </L>
  );
}

export function IconBot({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </L>
  );
}

export function IconCheckCircle({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M21.801 10A10 10 0 1 1 17 3.335" />
      <path d="m9 11 3 3L22 4" />
    </L>
  );
}

export function IconChevronRight({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="m9 18 6-6-6-6" />
    </L>
  );
}

export function IconCoins({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M13.744 17.736a6 6 0 1 1-7.48-7.48" />
      <path d="M15 6h1v4" />
      <path d="m6.134 14.768.866-.5 2 3.464" />
      <circle cx="16" cy="8" r="6" />
    </L>
  );
}

export function IconCrown({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" />
      <path d="M5 21h14" />
    </L>
  );
}

export function IconDice5({ className }: { className?: string }) {
  return (
    <L className={className}>
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <path d="M16 8h.01" />
      <path d="M8 8h.01" />
      <path d="M8 16h.01" />
      <path d="M16 16h.01" />
      <path d="M12 12h.01" />
    </L>
  );
}

export function IconFlag({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528" />
    </L>
  );
}

export function IconFlame2({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4" />
    </L>
  );
}

export function IconGift({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M12 7v14" />
      <path d="M20 11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8" />
      <path d="M7.5 7a1 1 0 0 1 0-5A4.8 8 0 0 1 12 7a4.8 8 0 0 1 4.5-5 1 1 0 0 1 0 5" />
      <rect x="3" y="7" width="18" height="4" rx="1" />
    </L>
  );
}

export function IconHouse({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </L>
  );
}

export function IconLink({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </L>
  );
}

export function IconLock({ className }: { className?: string }) {
  return (
    <L className={className}>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </L>
  );
}

export function IconMenu2({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M4 5h16" />
      <path d="M4 12h16" />
      <path d="M4 19h16" />
    </L>
  );
}

export function IconMinus({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M5 12h14" />
    </L>
  );
}

export function IconPencil({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </L>
  );
}

export function IconPlay({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
    </L>
  );
}

export function IconPlus({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </L>
  );
}

export function IconScale({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M12 3v18" />
      <path d="m19 8 3 8a5 5 0 0 1-6 0zV7" />
      <path d="M3 7h1a17 17 0 0 0 8-2 17 17 0 0 0 8 2h1" />
      <path d="m5 8 3 8a5 5 0 0 1-6 0zV7" />
      <path d="M7 21h10" />
    </L>
  );
}

export function IconShare({ className }: { className?: string }) {
  return (
    <L className={className}>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" x2="15.42" y1="13.51" y2="17.49" />
      <line x1="15.41" x2="8.59" y1="6.51" y2="10.49" />
    </L>
  );
}

export function IconShieldCheck({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </L>
  );
}

export function IconSignal({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M2 20h.01" />
      <path d="M7 20v-4" />
      <path d="M12 20v-8" />
      <path d="M17 20V8" />
      <path d="M22 4v16" />
    </L>
  );
}

export function IconStore({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5" />
      <path d="M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244" />
      <path d="M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05" />
    </L>
  );
}

export function IconSwords({ className }: { className?: string }) {
  return (
    <L className={className}>
      <polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5" />
      <line x1="13" x2="19" y1="19" y2="13" />
      <line x1="16" x2="20" y1="16" y2="20" />
      <line x1="19" x2="21" y1="21" y2="19" />
      <polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5" />
      <line x1="5" x2="9" y1="14" y2="18" />
      <line x1="7" x2="4" y1="17" y2="20" />
      <line x1="3" x2="5" y1="19" y2="21" />
    </L>
  );
}

export function IconTicket2({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2" />
      <path d="M13 17v2" />
      <path d="M13 11v2" />
    </L>
  );
}

export function IconTrophy2({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2" />
      <path d="M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2" />
      <path d="M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3" />
      <path d="M4 22h16" />
      <path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z" />
      <path d="M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3" />
    </L>
  );
}

export function IconUserPlus({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="19" x2="19" y1="8" y2="14" />
      <line x1="22" x2="16" y1="11" y2="11" />
    </L>
  );
}

export function IconUserRound({ className }: { className?: string }) {
  return (
    <L className={className}>
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </L>
  );
}

export function IconUsers2({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <path d="M16 3.128a4 4 0 0 1 0 7.744" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <circle cx="9" cy="7" r="4" />
    </L>
  );
}

export function IconUsersRound({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M18 21a8 8 0 0 0-16 0" />
      <circle cx="10" cy="8" r="5" />
      <path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" />
    </L>
  );
}

export function IconVolume({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
      <path d="M16 9a5 5 0 0 1 0 6" />
      <path d="M19.364 18.364a9 9 0 0 0 0-12.728" />
    </L>
  );
}

export function IconWallet({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </L>
  );
}

export function IconWifi({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M12 20h.01" />
      <path d="M2 8.82a15 15 0 0 1 20 0" />
      <path d="M5 12.859a10 10 0 0 1 14 0" />
      <path d="M8.5 16.429a5 5 0 0 1 7 0" />
    </L>
  );
}

export function IconX({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </L>
  );
}

/** Lucide's `smile`, transcribed: the icons/ path 404s on main at the time of
 *  vendoring, but the glyph is unchanged in the published package. */
export function IconSmile({ className }: { className?: string }) {
  return (
    <L className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <path d="M9 9h.01" />
      <path d="M15 9h.01" />
    </L>
  );
}
export function IconGlobe({ className }: { className?: string }) {
  return (
    <L className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </L>
  );
}

export function IconHelp({ className }: { className?: string }) {
  return (
    <L className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </L>
  );
}

export function IconMail({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" />
      <rect x="2" y="4" width="20" height="16" rx="2" />
    </L>
  );
}

export function IconSettings({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3" />
    </L>
  );
}

export function IconCopy({ className }: { className?: string }) {
  return (
    <L className={className}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </L>
  );
}

export function IconHourglass({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M5 22h14" />
      <path d="M5 2h14" />
      <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
      <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
    </L>
  );
}
export function IconVolumeOff({ className }: { className?: string }) {
  return (
    <L className={className}>
      <path d="M16 9a5 5 0 0 1 .95 2.293" />
      <path d="M19.364 5.636a9 9 0 0 1 1.889 9.96" />
      <path d="m2 2 20 20" />
      <path d="m7 7-.587.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298V11" />
      <path d="M9.828 4.172A.686.686 0 0 1 11 4.657v.686" />
    </L>
  );
}
