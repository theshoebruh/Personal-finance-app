import type { IconName } from '@/components/icons';

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** One-line description shown on the More page. */
  hint?: string;
}

/** Sidebar groups (desktop). Goals, Business, Budgets and the detailed overview are hidden. */
export const NAV_GROUPS: { label: string | null; items: NavItem[] }[] = [
  {
    label: null,
    items: [
      { to: '/', label: 'Home', icon: 'home' },
      { to: '/transactions', label: 'Activity', icon: 'activity' },
      { to: '/categories', label: 'Categories', icon: 'budgets' },
      { to: '/reports', label: 'Reports', icon: 'reports' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { to: '/import', label: 'Import statement', icon: 'import' },
      { to: '/accounts', label: 'Accounts', icon: 'accounts' },
      { to: '/settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

/** Pages listed on the phone's More page, in groups. */
export const MORE_GROUPS: NavItem[][] = [
  [
    { to: '/reports', label: 'Reports', icon: 'reports', hint: 'Charts of income and spending' },
    { to: '/accounts', label: 'Accounts', icon: 'accounts', hint: 'Balances and opening dates' },
  ],
  [
    {
      to: '/import',
      label: 'Import statement',
      icon: 'import',
      hint: 'Bring in a CSV and see past imports',
    },
    { to: '/settings', label: 'Settings', icon: 'settings', hint: 'Payday, sync, backup' },
  ],
];

/** Phone tab bar destinations (the Add button sits in the middle). */
export const TAB_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: 'home' },
  { to: '/transactions', label: 'Activity', icon: 'activity' },
  { to: '/categories', label: 'Categories', icon: 'budgets' },
];

/** Where the phone back link goes from each page that isn't a tab. */
export const BACK_LINKS: Record<string, { to: string; label: string }> = {
  '/reports': { to: '/more', label: 'More' },
  '/accounts': { to: '/more', label: 'More' },
  '/settings': { to: '/more', label: 'More' },
  '/import': { to: '/', label: 'Home' },
  // Hidden pages, still reachable by address.
  '/goals': { to: '/more', label: 'More' },
  '/business': { to: '/more', label: 'More' },
  '/budgets': { to: '/categories', label: 'Categories' },
  '/overview': { to: '/', label: 'Home' },
};

/** Paths that light up the More tab. */
export const MORE_PATHS = ['/more', '/reports', '/accounts', '/settings', '/goals', '/business'];
