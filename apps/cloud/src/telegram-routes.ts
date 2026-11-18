import { timingSafeEqual } from 'node:crypto';
import type { CloudTelegramStore } from '@mezon/db-cloud';
import { DomainError, type UnixMs, parseUuidV7 } from '@mezon/domain';
import type { FastifyInstance } from 'fastify';
import { createRequireAdminAuth } from './admin-routes.js';
import type { CloudConfig } from './config.js';
import type { CloudJwtService } from './jwt.js';
import type { TelegramBotService } from './telegram/bot-service.js';

export interface TelegramRoutesOptions {
  readonly config: CloudConfig;
  readonly jwtService: CloudJwtService;
  readonly store: CloudTelegramStore;
  /** Undefined when the bot is not configured: the webhook answers 404, link endpoints 503. */
  readonly bot?: TelegramBotService;
  readonly clock: { nowMs(): UnixMs };
}

function secretMatches(header: unknown, expected: string): boolean {
  if (typeof header !== 'string') return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** T2.8: Telegram webhook and the cabinet's link endpoints. */
export async function registerTelegramRoutes(
  app: FastifyInstance,
  opts: TelegramRoutesOptions,
): Promise<void> {
  await Promise.resolve();
  const requireAdminAuth = createRequireAdminAuth(opts.jwtService);
  const enabled = opts.bot !== undefined && opts.config.telegramWebhookSecret !== undefined;

  const linkUrl = (code: string) =>
    opts.config.telegramBotUsername
      ? `https://t.me/${opts.config.telegramBotUsername}?start=${code}`
      : null;

  // Telegram calls this with the secret it was registered with (setWebhook secret_token).
  app.post('/api/v1/telegram/webhook', { config: { rateLimit: false } }, async (req, reply) => {
    if (!enabled || !opts.bot || !opts.config.telegramWebhookSecret) {
      return reply.code(404).send({ error: 'Not Found' });
    }
    if (
      !secretMatches(
        req.headers['x-telegram-bot-api-secret-token'],
        opts.config.telegramWebhookSecret,
      )
    ) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    await opts.bot.handleUpdate(req.body);
    // Always 200 for an authenticated update, so Telegram does not retry it forever.
    return reply.code(200).send({ ok: true });
  });

  app.get(
    '/api/v1/admin/telegram/status',
    { preHandler: [requireAdminAuth] },
    async (req, reply) => {
      const user = req.user!;
      const status = await opts.store.getStaffLinkStatus(user.org, user.sub);
      return reply.code(200).send({
        enabled,
        linked: status.linked,
        linkedAtMs: status.linkedAtMs !== null ? status.linkedAtMs.toString() : null,
      });
    },
  );

  // A one-time link for the signed-in owner/manager's own chat (daily digest).
  app.post(
    '/api/v1/admin/telegram/link',
    { preHandler: [requireAdminAuth] },
    async (req, reply) => {
      if (!enabled) return reply.code(503).send({ error: 'Telegram bot is not configured' });
      const user = req.user!;
      const issued = await opts.store.issueLinkCode({
        organizationId: user.org,
        kind: 'staff',
        userId: user.sub,
        nowMs: opts.clock.nowMs(),
      });
      return reply.code(201).send({
        code: issued.code,
        url: linkUrl(issued.code),
        expiresAtMs: issued.expiresAtMs.toString(),
      });
    },
  );

  app.delete(
    '/api/v1/admin/telegram/link',
    { preHandler: [requireAdminAuth] },
    async (req, reply) => {
      const user = req.user!;
      await opts.store.revokeStaffLink(user.org, user.sub, opts.clock.nowMs());
      return reply.code(200).send({ status: 'ok' });
    },
  );

  // A one-time link the business gives a customer; reminders start only after the customer agrees.
  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/customers/:id/telegram-link',
    { preHandler: [requireAdminAuth] },
    async (req, reply) => {
      if (!enabled) return reply.code(503).send({ error: 'Telegram bot is not configured' });
      const user = req.user!;
      let customerId: string;
      try {
        customerId = parseUuidV7(req.params.id);
      } catch {
        return reply.code(400).send({ error: 'Invalid customer id' });
      }
      try {
        const issued = await opts.store.issueLinkCode({
          organizationId: user.org,
          kind: 'customer',
          customerId,
          nowMs: opts.clock.nowMs(),
        });
        return await reply.code(201).send({
          code: issued.code,
          url: linkUrl(issued.code),
          expiresAtMs: issued.expiresAtMs.toString(),
        });
      } catch (err) {
        if (err instanceof DomainError && err.code === 'CUSTOMER_NOT_FOUND') {
          return reply.code(404).send({ error: 'Customer not found' });
        }
        throw err;
      }
    },
  );
}
