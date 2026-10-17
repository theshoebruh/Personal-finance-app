/** Small line icons drawn inline (no icon font or external assets, per the CSP). Decorative only. */
export type IconName =
  | 'home'
  | 'activity'
  | 'plus'
  | 'budgets'
  | 'more'
  | 'reports'
  | 'goals'
  | 'accounts'
  | 'business'
  | 'import'
  | 'settings'
  | 'transfer'
  | 'file'
  | 'chevron-left'
  | 'chevron-right'
  | 'check'
  | 'close';

const PATHS: Record<IconName, string> = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  activity: 'M4 6h16M4 12h16M4 18h10',
  plus: 'M12 5v14M5 12h14',
  budgets: 'M12 4a8 8 0 1 0 8 8h-8z M15 2.5a7 7 0 0 1 6.5 6.5H15z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  reports: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  goals: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8z',
  accounts: 'M3 10h18M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18M12 3l9 5H3z',
  business: 'M4 8h16v12H4zM9 8V5h6v3M4 13h16',
  import: 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v3h16v-3',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7 7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7 7 0 0 0 1.7-1l2.4 1 2-3.4z',
  transfer: 'M7 7h12l-3-3M17 17H5l3 3',
  file: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5',
  'chevron-left': 'M15 18l-6-6 6-6',
  'chevron-right': 'M9 18l6-6-6-6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6 6l12 12M18 6L6 18',
};

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3.2 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
