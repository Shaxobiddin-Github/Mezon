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
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [storeId, setStoreId] = useState('');
  const [kassaName, setKassaName] = useState('');
  const [pairing, setPairing] = useState<{ code: string; expiresAtMs: number } | null>(null);

  const load = async () => {
    setError(null);
    try {
      const [d, s, st] = await Promise.all([
        adminApi.getDevices(),
        adminApi.getStaff(),
        adminApi.getStores(),
      ]);
      setDevices(d.devices);
      setStaff(s.staff);
      const active = st.stores.filter((x) => x.isActive);
      setStores(active);
      setStoreId((cur) => cur || active[0]?.id || '');
    } catch (err) {
      setError(describeApiError(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const newCode = async () => {
    setError(null);
    setPairing(null);
    try {
      const res = await adminApi.createPairingCode({
        storeId,
        name: kassaName.trim() || t('admin.devices.defaultName'),
      });
      setPairing({ code: res.code, expiresAtMs: res.expiresAtMs });
    } catch (err) {
      setError(describeApiError(err));
    }
  };

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
      <div className="bg-white rounded-lg border border-slate-200 p-4 space-y-3">
        <p className="font-semibold text-slate-900">{t('admin.devices.addTitle')}</p>
        <p className="text-xs text-slate-500">{t('admin.devices.addHelp')}</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-600">
            {t('admin.devices.store')}
            <select
              className="block mt-1 rounded border border-slate-300 px-2 py-1 text-sm"
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
            >
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-600">
            {t('admin.devices.kassaName')}
            <input
              className="block mt-1 w-48 rounded border border-slate-300 px-2 py-1 text-sm"
              maxLength={60}
              value={kassaName}
              onChange={(e) => setKassaName(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={!storeId}
            onClick={() => void newCode()}
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {t('admin.devices.getCode')}
          </button>
        </div>
        {pairing && (
          <p className="text-sm text-slate-900" data-testid="pairing-code">
            {t('admin.devices.code', {
              code: pairing.code,
              until: formatDateTime(String(pairing.expiresAtMs)),
            })}
          </p>
        )}
      </div>
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
