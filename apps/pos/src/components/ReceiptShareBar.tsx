import type { SaleDto } from '@mezon/contracts';
import { t } from '@mezon/i18n';
import { useState } from 'react';
import type { HubApiClient } from '../api/hub-client.js';
import { describeHubError } from '../utils/error-text.js';
import {
  nakladnoyHtml,
  printHtml,
  receiptPrintHtml,
  receiptTextToPng,
  sharePng,
} from '../utils/receipt-share.js';
import { Icon } from './Icon.js';

/**
 * C22: after a sale — send the receipt as a picture (Telegram, WhatsApp), print it on the office
 * printer of the computer, or print an A4 delivery note for the buyer. The phone has no print
 * dialog, so there only "share" is shown.
 */
export function ReceiptShareBar({
  api,
  sale,
}: {
  readonly api: HubApiClient;
  readonly sale: SaleDto;
}) {
  const [busy, setBusy] = useState<null | 'share' | 'print' | 'a4'>(null);
  const [error, setError] = useState<string | null>(null);
  const isPhone = window.mezonBridge?.shareImage !== undefined;

  const run = async (kind: 'share' | 'print' | 'a4') => {
    if (busy !== null) return;
    setBusy(kind);
    setError(null);
    try {
      const preview = await api.getReceiptPreview(sale.id, '80');
      const title = t('receipt.share.title', { code: preview.receiptCode });
      if (kind === 'share') {
        await sharePng(receiptTextToPng(preview.text), `chek-${preview.receiptCode}.png`, title);
      } else if (kind === 'print') {
        printHtml(receiptPrintHtml(title, preview.text));
      } else {
        printHtml(
          nakladnoyHtml({
            sale,
            shopTitle: preview.shopTitle,
            customerName: preview.customerName,
            dateText: preview.dateText,
            unitLabel: (u) => t(`unit.${u}` as 'unit.dona'),
            labels: {
              title: t('receipt.a4.title'),
              receipt: t('receipt.a4.receipt'),
              date: t('receipt.a4.date'),
              seller: t('receipt.a4.seller'),
              buyer: t('receipt.a4.buyer'),
              no: '№',
              item: t('receipt.a4.item'),
              qty: t('receipt.a4.qty'),
              price: t('receipt.a4.price'),
              discount: t('receipt.a4.discount'),
              sum: t('receipt.a4.sum'),
              total: t('receipt.a4.total'),
              paid: t('receipt.a4.paid'),
              debt: t('receipt.a4.debt'),
              handedOver: t('receipt.a4.handedOver'),
              received: t('receipt.a4.received'),
              currency: t('common.currency'),
            },
          }),
        );
      }
    } catch (err) {
      // the user closing the share sheet is not an error
      const msg = err instanceof Error ? err.message : '';
      if (!/cancel|abort/i.test(msg)) setError(describeHubError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pos-share-bar" data-testid="receipt-share-bar">
      <button
        type="button"
        className="pos-btn"
        data-testid="receipt-share-btn"
        disabled={busy !== null}
        onClick={() => void run('share')}
      >
        <Icon name="share" />
        {t('receipt.share.share')}
      </button>
      {!isPhone && (
        <>
          <button
            type="button"
            className="pos-btn"
            data-testid="receipt-office-print-btn"
            disabled={busy !== null}
            onClick={() => void run('print')}
          >
            <Icon name="printer" />
            {t('receipt.share.print')}
          </button>
          <button
            type="button"
            className="pos-btn"
            data-testid="receipt-a4-btn"
            disabled={busy !== null}
            onClick={() => void run('a4')}
          >
            <Icon name="receipts" />
            {t('receipt.share.a4')}
          </button>
        </>
      )}
      {error !== null && (
        <div className="pos-error-banner" role="alert" data-testid="receipt-share-error">
          {error}
        </div>
      )}
    </div>
  );
}
