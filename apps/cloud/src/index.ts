import { createCloudPgPool } from '@mezon/db-cloud';
import { loadCloudConfig } from './config.js';
import { buildCloudServer } from './server.js';

export * from './config.js';
export * from './jwt.js';
export * from './server.js';

export async function startCloudServer(): Promise<void> {
  const config = loadCloudConfig();
  console.log(`Starting @mezon/cloud API on ${config.host}:${config.port}...`);

  const conn = createCloudPgPool({
    connectionString: config.databaseUrl,
  });

  const server = await buildCloudServer({ config, conn });

  const address = await server.listen({
    host: config.host,
    port: config.port,
  });

  console.log(`@mezon/cloud API listening on ${address}`);

  const shutdown = async () => {
    console.log('Shutting down @mezon/cloud...');
    await server.close();
    await conn.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  startCloudServer().catch((err) => {
    console.error('Failed to start @mezon/cloud:', err);
    process.exit(1);
  });
}
