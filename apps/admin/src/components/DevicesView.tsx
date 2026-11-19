import React, { useEffect, useState } from 'react';
import { t } from '@mezon/i18n';
import { type CabinetDevice, type CabinetStaff, adminApi } from '../api-client.js';
import { describeApiError, formatDateTime } from '../utils/format.js';

const roleLabel = (role: string) =>
  role === 'owner'
    ? t('admin.staff.role.owner')
    : role === 'manager'
      ? t('admin.staff.role.manager')
      : t('admin.staff.role.cashier');

/** v1 cabinet: the organization's kassas (the owner can revoke one) and its staff (read-only). */
export const DevicesView: React.FC = () => {
  const [devices, setDevices] = useState<CabinetDevice[]>([]);
  const [staff, setStaff] = useState<CabinetStaff[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const [d, s] = await Promise.all([adminApi.getDevices(), adminApi.getStaff()]);
      setDevices(d.devices);
      setStaff(s.staff);
    } catch (err) {
      setError(describeApiError(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const revoke = async (d: CabinetDevice) => {
    if (!window.confirm(t('admin.devices.confirmRevoke', { name: d.name }))) return;
    setBusyId(d.id);
    try {
      await adminApi.revokeDevice(d.id);
      await load();
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">{t('admin.devices.title')}</h1>
        <p className="text-sm text-slate-500">{t('admin.devices.subtitle')}</p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100">
        {devices.length === 0 && (
          <p className="p-4 text-sm text-slate-400">{t('admin.devices.empty')}</p>
        )}
        {devices.map((d) => (
          <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="min-w-0">
              <p className="font-medium text-slate-900">
                {d.name}
                {d.storeName ? ` — ${d.storeName}` : ''}
              </p>
              <p className="text-xs text-slate-500">
                {t('admin.devices.lastSeen', { when: formatDateTime(d.lastSeenAtMs) })} ·{' '}
                {d.appVersion}
              </p>
            </div>
            {d.status === 'active' ? (
              <button
                type="button"
                disabled={busyId === d.id}
                onClick={() => void revoke(d)}
                className="text-xs font-semibold text-red-600 disabled:opacity-50"
              >
                {t('admin.devices.revoke')}
              </button>
            ) : (
              <span className="text-xs text-slate-400">{t('admin.devices.revoked')}</span>
            )}
          </div>
        ))}
      </div>

      <div>
        <h2 className="text-lg font-bold text-slate-900">{t('admin.staff.title')}</h2>
        <p className="text-sm text-slate-500">{t('admin.staff.subtitle')}</p>
      </div>
      <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100">
        {staff.length === 0 && (
          <p className="p-4 text-sm text-slate-400">{t('admin.staff.empty')}</p>
        )}
        {staff.map((u) => (
          <div key={u.id} className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="font-medium text-slate-900">{u.fullName}</p>
              <p className="text-xs text-slate-500">
                {u.username} · {roleLabel(u.role)}
              </p>
            </div>
            {!u.isActive && (
              <span className="text-xs text-slate-400">{t('admin.staff.inactive')}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
