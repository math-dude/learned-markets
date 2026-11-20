import type { SVGProps } from 'react'

const base = {
  'aria-hidden': true,
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  viewBox: '0 0 24 24',
} as const

type P = SVGProps<SVGSVGElement> & { size?: number }

export const BoardIcon = ({ size = 20, ...p }: P) => (
  <svg {...base} width={size} height={size} strokeWidth={2} {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
)

export const PortfolioIcon = ({ size = 20, ...p }: P) => (
  <svg {...base} width={size} height={size} strokeWidth={2} {...p}>
    <path d="M3 7h18v13H3z" />
    <path d="M8 7V4h8v3" />
  </svg>
)

export const InfoIcon = ({ size = 20, ...p }: P) => (
  <svg {...base} width={size} height={size} strokeWidth={2} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-4M12 8h.01" />
  </svg>
)

export const PlusIcon = ({ size = 22, ...p }: P) => (
  <svg {...base} width={size} height={size} strokeWidth={2.5} {...p}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const SearchIcon = ({ size = 18, ...p }: P) => (
  <svg {...base} width={size} height={size} strokeWidth={2} {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </svg>
)

export const BackIcon = ({ size = 14, ...p }: P) => (
  <svg {...base} width={size} height={size} strokeWidth={2.5} {...p}>
    <path d="M15 18l-6-6 6-6" />
  </svg>
)

export const UpArrowIcon = ({ size = 11, ...p }: P) => (
  <svg {...base} width={size} height={size} strokeWidth={3} {...p}>
    <path d="M12 20V8M5 13l7-7 7 7" />
  </svg>
)

export const PersonIcon = ({ size = 13, ...p }: P) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...p}>
    <circle cx="12" cy="7" r="4" />
    <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8z" />
  </svg>
)

export const TimerIcon = ({ size = 13, ...p }: P) => (
  <svg {...base} width={size} height={size} strokeWidth={2.5} {...p}>
    <circle cx="12" cy="13" r="8" />
    <path d="M12 9v4l2 2M10 2h4" />
  </svg>
)

export const Crown = ({ width = 32, height = 24, stroke = '#09090B' }: { width?: number; height?: number; stroke?: string }) => (
  <svg aria-hidden="true" width={width} height={height} viewBox="0 0 30 22">
    <path d="M2 20 L5 5 L11 12 L15 2 L19 12 L25 5 L28 20 Z" fill="#FBBF24" stroke={stroke} strokeWidth="2" strokeLinejoin="round" />
  </svg>
)
