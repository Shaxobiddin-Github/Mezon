import {
  type CabinetActor,
  type CloudCabinetStore,
  type CloudCommand,
  type CloudEventWriter,
  cabinetAttributionUserCommand,
  priceChangeCommands,
} from '@mezon/db-cloud';
import type { UnixMs, UuidV7 } from '@mezon/domain';

export type CabinetWriteErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION' | 'REJECTED';

export class CabinetWriteError extends Error {
  constructor(
    readonly code: CabinetWriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CabinetWriteError';
  }
}

/** Upper bound for a price in tiyin (10 billion so'm): a typo guard, not a business rule. */
export const MAX_PRICE_TIYIN = 1_000_000_000_000n;

/**
 * T2.7b — changes made in the business cabinet. Nothing is written to the cloud tables directly:
 * every change is an ordinary sync event through `CloudEventWriter` (same validation as a hub
 * push), so every hub of the organization receives it by the normal pull and last-writer-wins
 * holds everywhere.
 *
 * Who did it: the price-change fact names a hub `users` row. A cabinet login linked to a hub user
 * (`cloud_users.hub_user_id`) is that user. Otherwise the cabinet login gets its own attribution
 * row, created once: `is_active = false` and no PIN (credentials are hub-local), so it can never
 * sign in at a kassa — it only names who changed what.
 */
export class CloudCabinetService {
  constructor(
    private readonly o: {
      readonly store: CloudCabinetStore;
      readonly writer: CloudEventWriter;
      readonly idGen: { nextId(): UuidV7 };
      readonly clock: { nowMs(): UnixMs };
    },
  ) {}

  private async actor(org: UuidV7, cloudUserId: UuidV7): Promise<CabinetActor> {
    const actor = await this.o.store.getActor(org, cloudUserId);
    if (actor === null) {
      throw new CabinetWriteError('FORBIDDEN', 'Only an active owner or manager can do this');
    }
    return actor;
  }

  /** The hub user id that names this cabinet user, plus the command creating it if needed. */
  private async attribution(
    org: UuidV7,
    actor: CabinetActor,
    nowMs: UnixMs,
  ): Promise<{ readonly userId: UuidV7; readonly commands: CloudCommand[] }> {
    if (actor.hubUserId !== null) return { userId: actor.hubUserId, commands: [] };
    const userId = actor.cloudUserId;
    if ((await this.o.store.loadOrgRow(org, 'users', userId)) !== null) {
      return { userId, commands: [] };
    }
    return {
      userId,
      commands: [
        cabinetAttributionUserCommand({
          organizationId: org,
          cloudUserId: userId,
          username: actor.username,
          role: actor.role,
          nowMs,
        }),
      ],
    };
  }

  private async write(org: UuidV7, commands: CloudCommand[], nowMs: UnixMs): Promise<void> {
    const res = await this.o.writer.write({ organizationId: org, nowMs, commands });
    const bad = res.results.find((r) => r.status !== 'accepted' && r.status !== 'duplicate');
    if (bad) {
      throw new CabinetWriteError(
        'REJECTED',
        `Change was not accepted (${bad.status}${bad.reason ? `: ${bad.reason}` : ''})`,
      );
    }
  }

  /** Sale price of a product, recorded in the price history with who and when. */
  async changeProductPrice(p: {
    readonly organizationId: UuidV7;
    readonly cloudUserId: UuidV7;
    readonly productId: UuidV7;
    readonly newPriceTiyin: bigint;
    readonly reason: string | null;
  }): Promise<{ readonly changed: boolean; readonly oldPrice: string | null }> {
    if (p.newPriceTiyin < 0n || p.newPriceTiyin > MAX_PRICE_TIYIN) {
      throw new CabinetWriteError('VALIDATION', 'Price is out of range');
    }
    const org = p.organizationId;
    const actor = await this.actor(org, p.cloudUserId);
    const product = await this.o.store.loadOrgRow(org, 'products', p.productId);
    if (product === null) throw new CabinetWriteError('NOT_FOUND', 'Product not found');
    if (product.hasVariants === true) {
      throw new CabinetWriteError(
        'VALIDATION',
        'This product has variants: change variant prices at the kassa',
      );
    }
    const oldPrice = product.salePrice === null ? null : String(product.salePrice);
    const newPrice = p.newPriceTiyin.toString();
    if (oldPrice === newPrice) return { changed: false, oldPrice };

    const nowMs = this.o.clock.nowMs();
    const who = await this.attribution(org, actor, nowMs);
    const commands: CloudCommand[] = [
      ...who.commands,
      ...priceChangeCommands({
        organizationId: org,
        product,
        newPriceTiyin: p.newPriceTiyin,
        changedByUserId: who.userId,
        reason: p.reason,
        priceChangeId: this.o.idGen.nextId(),
        nowMs,
      }),
    ];
    await this.write(org, commands, nowMs);
    return { changed: true, oldPrice };
  }
}
