import type { CSSProperties } from 'react';
export type IconName = 'chat' | 'brain' | 'skill' | 'folder' | 'plus' | 'arrow' | 'stop' | 'chevron' | 'logout' | 'menu' | 'close' | 'search' | 'terminal' | 'clock' | 'check' | 'settings' | 'refresh' | 'link' | 'layers' | 'globe' | 'code' | 'trash';
const paths: Record<IconName, React.ReactNode> = {
  layers: <><path d="m12 3 10 5-10 5L2 8l10-5Z" /><path d="m2 12 10 5 10-5M2 16l10 5 10-5" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" /></>,
  code: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" /></>,
  chat: <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H5l-3 2v-9.5a8.5 8.5 0 0 1 19-1Z" />,
  brain: <><path d="M12 4a3 3 0 0 0-5-2 3 3 0 0 0-3 4 4 4 0 0 0-1 7 4 4 0 0 0 4 6 3 3 0 0 0 5 2V4Zm0 0a3 3 0 0 1 5-2 3 3 0 0 1 3 4 4 4 0 0 1 1 7 4 4 0 0 1-4 6 3 3 0 0 1-5 2" /><path d="M7 6c0 2 1 3 3 3M4 13c2-1 4 0 4 2m9-9c0 2-1 3-3 3m6 4c-2-1-4 0-4 2" /></>,
  skill: <path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z" />,
  folder: <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  logout: <><path d="M9 4H4v16h5m6-12 4 4-4 4m-6-4h10" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  terminal: <><rect x="2" y="3" width="20" height="18" rx="3" /><path d="m6 8 4 4-4 4m7 0h5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
  refresh: <><path d="M20 7V3l-3 3a8 8 0 1 0 3 8" /><path d="M20 7h-5" /></>,
  link: <><path d="m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 0 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" /></>,
};
export function Icon({ name, size = 18, style, className = '' }: { name: IconName; size?: number; style?: CSSProperties; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} style={style}>{paths[name]}</svg>;
}
