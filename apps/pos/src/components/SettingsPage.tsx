import { t } from '@mezon/i18n';
import { useState } from 'react';
import type { HubApiClient } from '../api/hub-client.js';
import type { TerminalInfo } from '../bridge.js';
import { ConnectionsModal } from './ConnectionsPanels.js';
import { SyncConflictsModal } from './SyncConflictsModal.js';

/** Owner/manager settings as a section: connections (cloud, second kassa) and sync conflicts. */
export function SettingsPage(props: {
  readonly api: HubApiClient;
  readonly role: 'owner' | 'manager';
  readonly terminalInfo: TerminalInfo;
  readonly onError: (err: unknown) => void;
}) {
  const { api, role, terminalInfo, onError } = props;
  const [tab, setTab] = useState<'connections' | 'sync'>('connections');
  return (
    <section className="pos-page" data-testid="settings-page">
      <header className="pos-page-header">
        <h2 className="pos-page-title">{t('settings.title')}</h2>
        <div className="pos-segmented" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'connections'}
            className={tab === 'connections' ? 'pos-segmented-active' : ''}
            data-testid="settings-tab-connections"
            onClick={() => setTab('connections')}
          >
            {t('settings.tabConnections')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'sync'}
            className={tab === 'sync' ? 'pos-segmented-active' : ''}
            data-testid="settings-tab-sync"
            onClick={() => setTab('sync')}
          >
            {t('settings.tabSync')}
          </button>
        </div>
      </header>
      <div className="pos-page-host">
        {tab === 'connections' ? (
          <ConnectionsModal
            api={api}
            role={role}
            terminalInfo={terminalInfo}
            onClose={() => undefined}
            onError={onError}
          />
        ) : (
          <SyncConflictsModal api={api} onClose={() => undefined} onError={onError} />
        )}
      </div>
    </section>
  );
}
