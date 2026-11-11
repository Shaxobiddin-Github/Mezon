import { t } from '@mezon/i18n';
import { formatTiyinToSom, parseSomInputToTiyinString, tiyinToSomInputString } from '@mezon/ui';
import { type FormEvent, useState } from 'react';
import { type HubApiClient, HubApiError } from '../api/hub-client.js';
import { usePosStore } from '../store/pos-store.js';
import { generateBrowserUuidV7 } from '../utils/browser-uuid.js';

export function SetupScreen({
  api,
  onSetupCompleted,
  onError,
}: {
  readonly api: HubApiClient;
  readonly onSetupCompleted: () => Promise<void>;
  readonly onError: (err: unknown) => void;
}) {
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.setup({
        owner: {
          fullName,
          username,
          pin,
        },
      });
      await onSetupCompleted();
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="pos-auth-container" data-testid="setup-screen">
      <h2>{t('setup.title')}</h2>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <div className="pos-form-group">
          <label className="pos-form-label" htmlFor="setup-fullname">
            {t('setup.fullName')}
          </label>
          <input
            id="setup-fullname"
            className="pos-input"
            data-testid="setup-fullname-input"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            autoFocus
          />
        </div>

        <div className="pos-form-group">
          <label className="pos-form-label" htmlFor="setup-username">
            {t('setup.username')}
          </label>
          <input
            id="setup-username"
            className="pos-input"
            data-testid="setup-username-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>

        <div className="pos-form-group">
          <label className="pos-form-label" htmlFor="setup-pin">
            {t('setup.pin')}
          </label>
          <input
            id="setup-pin"
            type="password"
            className="pos-input"
            data-testid="setup-pin-input"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            required
          />
        </div>

        <button type="submit" className="pos-btn pos-btn-primary" data-testid="setup-submit-btn">
          {t('setup.submit')}
        </button>
      </form>
    </div>
  );
}

export function LoginScreen({
  api,
  onLoginSuccess,
  onError,
}: {
  readonly api: HubApiClient;
  readonly onLoginSuccess: (token: string) => Promise<void>;
  readonly onError: (err: unknown) => void;
}) {
  const loginOptions = usePosStore((s) => s.loginOptions);
  const authRateLimitSeconds = usePosStore((s) => s.authRateLimitSeconds);
  const setAuthRateLimitSeconds = usePosStore((s) => s.setAuthRateLimitSeconds);
  const setAuthenticated = usePosStore((s) => s.setAuthenticated);
  const setErrorBanner = usePosStore((s) => s.setErrorBanner);

  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setErrorBanner(null);
      const payload =
        selectedUserId.length > 0 ? { userId: selectedUserId, pin } : { username, pin };
      const res = await api.login(payload);
      setAuthenticated(res.token, res.user);
      await onLoginSuccess(res.token);
    } catch (err) {
      if (err instanceof HubApiError && err.code === 'AUTH_RATE_LIMITED') {
        const secs = err.retryAfterSeconds ?? 300;
        setAuthRateLimitSeconds(secs);
        setErrorBanner(t('auth.rateLimited', { seconds: secs }));
        return;
      }
      onError(err);
    }
  };

  const appendPinDigit = (digit: string) => {
    setPin((prev) => (prev.length < 16 ? prev + digit : prev));
  };

  return (
    <div className="pos-auth-container" data-testid="login-screen">
      <h2>{t('auth.title')}</h2>

      {authRateLimitSeconds > 0 && (
        <div className="pos-error-banner" data-testid="login-rate-limit-banner">
          {t('auth.rateLimited', { seconds: authRateLimitSeconds })}
        </div>
      )}

      {loginOptions.length > 0 && (
        <div className="pos-quick-tenders" data-testid="login-options-list">
          {loginOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={`pos-btn ${selectedUserId === opt.id ? 'pos-btn-primary' : ''}`}
              data-testid={`login-option-${opt.id}`}
              onClick={() => {
                setSelectedUserId(opt.id);
                setUsername('');
              }}
            >
              {opt.fullName} ({opt.role})
            </button>
          ))}
        </div>
      )}

      <form onSubmit={(e) => void handleSubmit(e)}>
        {selectedUserId.length === 0 && (
          <div className="pos-form-group">
            <label className="pos-form-label" htmlFor="login-username">
              {t('auth.usernamePlaceholder')}
            </label>
            <input
              id="login-username"
              className="pos-input"
              data-testid="login-username-input"
              placeholder={t('auth.usernamePlaceholder')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
            />
          </div>
        )}

        <div className="pos-form-group">
          <label className="pos-form-label" htmlFor="login-pin">
            {t('auth.pinPlaceholder')}
          </label>
          <input
            id="login-pin"
            type="password"
            className="pos-input"
            data-testid="login-pin-input"
            placeholder={t('auth.pinPlaceholder')}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            required
            autoFocus={selectedUserId.length > 0}
          />
        </div>

        <div className="pos-numpad" data-testid="login-numpad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
            <button
              key={digit}
              type="button"
              className="pos-numpad-btn"
              data-testid={`login-numpad-${digit}`}
              onClick={() => appendPinDigit(digit)}
            >
              {digit}
            </button>
          ))}
          <button
            type="button"
            className="pos-numpad-btn"
            data-testid="login-numpad-clear"
            onClick={() => setPin('')}
          >
            {t('auth.Clear')}
          </button>
          <button
            type="button"
            className="pos-numpad-btn"
            data-testid="login-numpad-0"
            onClick={() => appendPinDigit('0')}
          >
            0
          </button>
          <button
            type="button"
            className="pos-numpad-btn"
            data-testid="login-numpad-backspace"
            onClick={() => setPin((p) => p.slice(0, -1))}
          >
            {t('auth.Backspace')}
          </button>
        </div>

        <button type="submit" className="pos-btn pos-btn-primary" data-testid="login-submit-btn">
          {t('auth.loginButton')}
        </button>
      </form>
    </div>
  );
}

export function OpenShiftScreen({
  api,
  onShiftOpened,
  onError,
}: {
  readonly api: HubApiClient;
  readonly onShiftOpened: () => Promise<void>;
  readonly onError: (err: unknown) => void;
}) {
  const drawerCashBalance = usePosStore((s) => s.drawerCashBalance);
  const lastShiftClosure = usePosStore((s) => s.lastShiftClosure);
  const setShiftState = usePosStore((s) => s.setShiftState);

  const [openingCashSom, setOpeningCashSom] = useState(tiyinToSomInputString(drawerCashBalance));
  const [discrepancyReason, setDiscrepancyReason] = useState('');
  const [note, setNote] = useState('');
  const [requestId] = useState(() => generateBrowserUuidV7());

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const openingCashTiyin = parseSomInputToTiyinString(openingCashSom);
      const res = await api.openShift({
        clientRequestId: requestId,
        openingCash: openingCashTiyin,
        openingDiscrepancyReason:
          discrepancyReason.trim().length > 0 ? discrepancyReason.trim() : undefined,
        note: note.trim().length > 0 ? note.trim() : null,
      });
      setShiftState({
        shift: res.shift,
        drawerCashBalance: res.drawerCashBalance,
      });
      await onShiftOpened();
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="pos-auth-container" data-testid="open-shift-screen">
      <h2>{t('shift.openTitle')}</h2>
      <p>{t('shift.openSubtitle')}</p>

      {lastShiftClosure && (
        <div className="pos-pane" data-testid="last-shift-closure-summary">
          <strong>{t('shift.closedSummaryTitle')}</strong>
          <div className="pos-totals-row">
            <span>{t('shift.expectedCash')}:</span>
            <span data-testid="closure-expected-cash">
              {formatTiyinToSom(lastShiftClosure.expectedCash)} {t('common.currency')}
            </span>
          </div>
          <div className="pos-totals-row">
            <span>{t('shift.actualCountedCash')}:</span>
            <span data-testid="closure-counted-cash">
              {formatTiyinToSom(lastShiftClosure.countedCash)} {t('common.currency')}
            </span>
          </div>
          <div className="pos-totals-row">
            <span>{t('shift.discrepancy')}:</span>
            <span data-testid="closure-discrepancy">
              {formatTiyinToSom(lastShiftClosure.discrepancy)} {t('common.currency')}
            </span>
          </div>
        </div>
      )}

      <div className="pos-totals-row">
        <span>{t('shift.drawerBalance')}:</span>
        <strong data-testid="open-shift-drawer-balance">
          {formatTiyinToSom(drawerCashBalance)} {t('common.currency')}
        </strong>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)}>
        <div className="pos-form-group">
          <label className="pos-form-label" htmlFor="open-shift-cash">
            {t('shift.openingCash')}
          </label>
          <input
            id="open-shift-cash"
            className="pos-input"
            data-testid="open-shift-cash-input"
            value={openingCashSom}
            onChange={(e) => setOpeningCashSom(e.target.value)}
            required
            autoFocus
          />
        </div>

        <div className="pos-form-group">
          <label className="pos-form-label" htmlFor="open-shift-reason">
            {t('shift.discrepancyReason')}
          </label>
          <input
            id="open-shift-reason"
            className="pos-input"
            data-testid="open-shift-reason-input"
            value={discrepancyReason}
            onChange={(e) => setDiscrepancyReason(e.target.value)}
          />
        </div>

        <div className="pos-form-group">
          <label className="pos-form-label" htmlFor="open-shift-note">
            {t('shift.note')}
          </label>
          <input
            id="open-shift-note"
            className="pos-input"
            data-testid="open-shift-note-input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        <button
          type="submit"
          className="pos-btn pos-btn-primary"
          data-testid="open-shift-submit-btn"
        >
          {t('shift.openButton')}
        </button>
      </form>
    </div>
  );
}
