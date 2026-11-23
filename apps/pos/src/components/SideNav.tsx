import { t } from '@mezon/i18n';
import type { ReactNode } from 'react';
import type { PosSection } from '../store/pos-store.js';

/** Small inline line icons (no icon font or network). 24x24 viewBox, currentColor stroke. */
const ICONS: Readonly<Record<string, ReactNode>> = {
  sale: (
    <>
      <path d="M3 4h2l2.4 10.2a1.5 1.5 0 0 0 1.5 1.1h8.3a1.5 1.5 0 0 0 1.4-1l2-6.3H6.2" />
      <circle cx="9.5" cy="19.5" r="1.3" />
      <circle cx="17" cy="19.5" r="1.3" />
    </>
  ),
  receipts: (
    <>
      <path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21z" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </>
  ),
  products: (
    <>
      <path d="M12 3 4 7v10l8 4 8-4V7z" />
      <path d="m4 7 8 4 8-4M12 11v10" />
    </>
  ),
  shift: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18M7 15h4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M4.2 6.2l2.1 2.1M17.7 15.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 17.8l2.1-2.1M17.7 8.3l2.1-2.1" />
    </>
  ),
  fiscal: (
    <>
      <path d="M12 3 3 20h18z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </>
  ),
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  percent: (
    <>
      <path d="M19 5 5 19" />
      <circle cx="6.5" cy="6.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
    </>
  ),
  pause: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 9v6M14 9v6" />
    </>
  ),
  stack: (
    <>
      <path d="m12 3 9 5-9 5-9-5z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
    </>
  ),
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="14" rx="2" />
      <path d="M3 10h18M16 15h2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  scan: (
    <>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M7 9v6M10 9v6M13 9v6M16 9v6" />
    </>
  ),
};

/** A label with its hotkey kept apart: "Tez savdo (F3)" → ["Tez savdo", "F3"]. */
export function splitHotkey(label: string): readonly [string, string | null] {
  const m = /^(.*?)\s*\((F\d{1,2})\)\s*$/.exec(label);
  return m ? [m[1] ?? label, m[2] ?? null] : [label, null];
}

export type IconName = keyof typeof ICONS;

export function NavIcon({ name }: { readonly name: IconName }) {
  return (
    <svg
      className="pos-nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

interface NavItem {
  readonly key: PosSection | 'shift' | 'fiscal' | 'shortcuts';
  readonly label: string;
  readonly hint?: string;
  readonly icon: keyof typeof ICONS;
}

/**
 * Left side menu: the kassa's sections. Sections are pages; "Smena", "Fiskal" and "Tugmalar"
 * open their dialogs over the current page (F8 / F1 keep working).
 */
export function SideNav(props: {
  readonly section: PosSection;
  readonly role: 'owner' | 'manager' | 'cashier' | null;
  readonly fiscalMode: boolean;
  readonly onSection: (section: PosSection) => void;
  readonly onShift: () => void;
  readonly onFiscal: () => void;
  readonly onShortcuts: () => void;
}) {
  const { section, role, fiscalMode, onSection, onShift, onFiscal, onShortcuts } = props;
  const isManager = role === 'owner' || role === 'manager';

  const main: NavItem[] = [
    { key: 'sale', label: t('nav.sale'), icon: 'sale' },
    { key: 'receipts', label: t('nav.receipts'), icon: 'receipts' },
    ...(isManager
      ? [{ key: 'products' as const, label: t('nav.products'), icon: 'products' }]
      : []),
    { key: 'shift', label: t('nav.shift'), hint: 'F8', icon: 'shift' },
  ];
  const admin: NavItem[] = [
    ...(fiscalMode && isManager
      ? [{ key: 'fiscal' as const, label: t('nav.fiscal'), icon: 'fiscal' }]
      : []),
    ...(isManager
      ? [{ key: 'settings' as const, label: t('nav.settings'), icon: 'settings' }]
      : []),
    { key: 'shortcuts', label: t('nav.shortcuts'), hint: 'F1', icon: 'keyboard' },
  ];

  const click = (key: NavItem['key']) => {
    if (key === 'shift') onShift();
    else if (key === 'fiscal') onFiscal();
    else if (key === 'shortcuts') onShortcuts();
    else onSection(key);
  };

  const render = (item: NavItem) => {
    const active = item.key === section;
    return (
      <button
        key={item.key}
        type="button"
        className={`pos-nav-item ${active ? 'pos-nav-item-active' : ''}`}
        data-testid={`nav-${item.key}`}
        aria-current={active ? 'page' : undefined}
        title={item.label}
        onClick={() => click(item.key)}
      >
        <NavIcon name={item.icon} />
        <span className="pos-nav-label">{item.label}</span>
        {item.hint && <kbd className="pos-nav-hint">{item.hint}</kbd>}
      </button>
    );
  };

  return (
    <nav className="pos-sidenav" aria-label={t('nav.title')}>
      <div className="pos-nav-group">{main.map(render)}</div>
      <div className="pos-nav-group pos-nav-group-bottom">{admin.map(render)}</div>
    </nav>
  );
}
