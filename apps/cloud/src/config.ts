import { z } from 'zod';

export const CloudConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().positive().default(4000),
  databaseUrl: z.string().min(1, 'DATABASE_URL is required'),
  jwtSecret: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  corsOrigins: z
    .string()
    .default('*')
    .transform((val) => val.split(',').map((s) => s.trim())),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  appDbPassword: z.string().optional(),
  /**
   * T2.8 Telegram bot. Disabled unless both the token and the webhook secret are set (env only,
   * never committed). The secret must match Telegram's X-Telegram-Bot-Api-Secret-Token header.
   */
  telegramBotToken: z.string().optional(),
  telegramWebhookSecret: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,256}$/, 'TELEGRAM_WEBHOOK_SECRET: 32-256 chars [A-Za-z0-9_-]')
    .optional(),
  telegramBotUsername: z
    .string()
    .regex(/^[A-Za-z0-9_]{5,32}$/)
    .optional(),
  /** Local hour (store time zone) for the owner's daily digest. */
  telegramDigestHour: z.coerce.number().int().min(0).max(23).default(21),
  /** Local hour for customer debt reminders (at most once a week per customer). */
  telegramReminderHour: z.coerce.number().int().min(0).max(23).default(10),
});

export type CloudConfig = z.infer<typeof CloudConfigSchema>;

export function loadCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const result = CloudConfigSchema.safeParse({
    host: env.HOST,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    jwtSecret: env.JWT_SECRET,
    corsOrigins: env.CORS_ORIGINS,
    nodeEnv: env.NODE_ENV,
    appDbPassword: env.MEZON_APP_DB_PASSWORD,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET || undefined,
    telegramBotUsername: env.TELEGRAM_BOT_USERNAME || undefined,
    telegramDigestHour: env.TELEGRAM_DIGEST_HOUR,
    telegramReminderHour: env.TELEGRAM_REMINDER_HOUR,
  });

  if (!result.success) {
    const errorDetails = result.error.issues
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join(', ');
    throw new Error(`Invalid Cloud configuration: ${errorDetails}`);
  }

  if (
    (result.data.telegramBotToken === undefined) !==
    (result.data.telegramWebhookSecret === undefined)
  ) {
    throw new Error(
      'Invalid Cloud configuration: TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must be set together',
    );
  }
  return result.data;
}

export function isTelegramEnabled(config: CloudConfig): boolean {
  return config.telegramBotToken !== undefined && config.telegramWebhookSecret !== undefined;
}
