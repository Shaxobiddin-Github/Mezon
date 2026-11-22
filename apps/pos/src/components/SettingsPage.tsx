import type { IntegrationsStatusResponse } from '@mezon/contracts';
import { t } from '@mezon/i18n';
import { useState } from 'react';
import type { HubApiClient } from '../api/hub-client.js';
import type { TerminalInfo } from '../bridge.js';
import { ConnectionsModal } from './ConnectionsPanels.js';
import { IntegrationsPanel } from './IntegrationsPanel.js';
import { SyncConflictsModal } from './SyncConflictsModal.js';
import { Icon } from './Icon.js';

/** Owner/manager settings as a section: connections (cloud, second kassa) and sync conflicts. */
export function SettingsPage(props: {
  readonly api: HubApiClient;
  readonly role: 'owner' | 'manager';
  readonly terminalInfo: TerminalInfo;
  readonly onError: (err: unknown) => void;
  readonly onIntegrationsChanged?: (st: IntegrationsStatusResponse) => void;
}) {
  const { api, role, terminalInfo, onError, onIntegrationsChanged } = props;
  const [tab, setTab] = useState<'connections' | 'integrations' | 'sync'>('connections');
  return (
    <section className="pos-page" data-testid="settings-page">
      <header className="pos-page-header">
        <h2 className="pos-page-title pos-title-icon">
          <Icon name="settings" />
          {t('settings.title')}
        </h2>
        <div className="pos-segmented" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'connections'}
            className={tab === 'connections' ? 'pos-segmented-active' : ''}
            data-testid="settings-tab-connections"
            onClick={() => setTab('connections')}
          >
            <Icon name="link" />
            {t('settings.tabConnections')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'integrations'}
            className={tab === 'integrations' ? 'pos-segmented-active' : ''}
            data-testid="settings-tab-integrations"
            onClick={() => setTab('integrations')}
          >
            <Icon name="shield" />
            {t('settings.tabIntegrations')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'sync'}
            className={tab === 'sync' ? 'pos-segmented-active' : ''}
            data-testid="settings-tab-sync"
            onClick={() => setTab('sync')}
          >
            <Icon name="refresh" />
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
        ) : tab === 'integrations' ? (
          <IntegrationsPanel
            api={api}
            role={role}
            onError={onError}
            {...(onIntegrationsChanged ? { onChanged: onIntegrationsChanged } : {})}
          />
        ) : (
          <SyncConflictsModal api={api} onClose={() => undefined} onError={onError} />
        )}
      </div>
    </section>
  );
}
