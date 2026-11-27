import { t } from '@mezon/i18n';
import type { PosSection } from '../store/pos-store.js';
import { Icon, type IconName } from './Icon.js';

/** A label with its hotkey kept apart: "Tez savdo (F3)" → ["Tez savdo", "F3"]. */
export function splitHotkey(label: string): readonly [string, string | null] {
  const m = /^(.*?)\s*\((F\d{1,2})\)\s*$/.exec(label);
  return m ? [m[1] ?? label, m[2] ?? null] : [label, null];
}

/** Kept for older imports: the side menu icon is the shared kassa icon. */
export function NavIcon({ name }: { readonly name: IconName }) {
  return <Icon name={name} />;
}

export type { IconName };

interface NavItem {
  readonly key: PosSection | 'shift' | 'fiscal' | 'shortcuts';
  readonly label: string;
  readonly hint?: string;
  readonly icon: IconName;
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
    ...(isManager
      ? [{ key: 'dashboard' as const, label: t('nav.dashboard'), icon: 'chart' as const }]
      : []),
    { key: 'sale', label: t('nav.sale'), icon: 'sale' },
    { key: 'receipts', label: t('nav.receipts'), icon: 'receipts' },
    ...(isManager
      ? [{ key: 'products' as const, label: t('nav.products'), icon: 'products' as const }]
      : []),
    { key: 'shift', label: t('nav.shift'), hint: 'F8', icon: 'shift' },
  ];
  const admin: NavItem[] = [
    ...(fiscalMode && isManager
      ? [{ key: 'fiscal' as const, label: t('nav.fiscal'), icon: 'fiscal' as const }]
      : []),
    ...(isManager
      ? [{ key: 'settings' as const, label: t('nav.settings'), icon: 'settings' as const }]
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
