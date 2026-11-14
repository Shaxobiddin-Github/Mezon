import { z } from 'zod';

export const CloudConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().positive().default(4000),
  databaseUrl: z.string().min(1, 'DATABASE_URL is required'),
  databaseAdminUrl: z.string().optional(),
  jwtSecret: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  corsOrigins: z
    .string()
    .default('*')
    .transform((val) => val.split(',').map((s) => s.trim())),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  appDbPassword: z.string().optional(),
});

export type CloudConfig = z.infer<typeof CloudConfigSchema>;

export function loadCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const result = CloudConfigSchema.safeParse({
    host: env.HOST,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    databaseAdminUrl: env.DATABASE_ADMIN_URL,
    jwtSecret: env.JWT_SECRET,
    corsOrigins: env.CORS_ORIGINS,
    nodeEnv: env.NODE_ENV,
    appDbPassword: env.MEZON_APP_DB_PASSWORD,
  });

  if (!result.success) {
    const errorDetails = result.error.issues
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join(', ');
    throw new Error(`Invalid Cloud configuration: ${errorDetails}`);
  }

  return result.data;
}
