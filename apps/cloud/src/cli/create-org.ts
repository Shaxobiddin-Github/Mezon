import { randomBytes } from 'node:crypto';
import { MonotonicUuidV7Generator, normalizeCloudLogin, unixMsFromBigInt } from '@mezon/domain';
import { createCloudPgPool, CloudTenantStore, migrateCloudDatabase } from '@mezon/db-cloud';
import * as argon2 from '@node-rs/argon2';
import { loadCloudConfig } from '../config.js';

interface CliArgs {
  orgName?: string;
  storeName?: string;
  storeCode?: string;
  login?: string;
  password?: string;
  username?: string;
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--org-name' && argv[i + 1]) args.orgName = argv[++i];
    else if (arg === '--store-name' && argv[i + 1]) args.storeName = argv[++i];
    else if (arg === '--store-code' && argv[i + 1]) args.storeCode = argv[++i];
    else if (arg === '--login' && argv[i + 1]) args.login = argv[++i];
    else if (arg === '--password' && argv[i + 1]) args.password = argv[++i];
    else if (arg === '--username' && argv[i + 1]) args.username = argv[++i];
  }
  return args;
}

export async function runCreateOrgCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const config = loadCloudConfig();
  const args = parseCliArgs(argv);

  const orgName = args.orgName ?? 'Guzar Kattaqo‘rg‘on Asosiy';
  const storeName = args.storeName ?? 'Bosh Do‘kon';
  const storeCode = args.storeCode ?? 'main';
  const login = normalizeCloudLogin(args.login ?? 'admin@guzar.uz');
  const username = args.username ?? 'Administrator';
  const rawPassword = args.password ?? 'Guzar2026!Secure';

  console.log(`[org:create] Connecting to database...`);
  const conn = createCloudPgPool({
    connectionString: config.databaseAdminUrl ?? config.databaseUrl,
  });

  try {
    // Run migrations if needed
    await migrateCloudDatabase(conn.db);

    const tenantStore = new CloudTenantStore(conn.pool);
    const idGen = new MonotonicUuidV7Generator({
      clock: { now: () => unixMsFromBigInt(BigInt(Date.now())) },
      random: { nextBytes: (n: number) => randomBytes(n) },
    });
    const nowMs = unixMsFromBigInt(BigInt(Date.now()));

    const organizationId = idGen.nextId();
    const storeId = idGen.nextId();
    const ownerUserId = idGen.nextId();
    const loginIdentityId = idGen.nextId();

    console.log(`[org:create] Hashing password with Argon2id (never logged)...`);
    const passwordHash = await argon2.hash(rawPassword);

    console.log(`[org:create] Creating organization "${orgName}"...`);
    const result = await tenantStore.createOrganizationWithStoreAndOwner({
      organizationId,
      storeId,
      ownerUserId,
      loginIdentityId,
      organizationName: orgName,
      storeName,
      storeCode,
      ownerUsername: username,
      ownerLogin: login,
      passwordHash,
      nowMs,
    });

    console.log(`[org:create] Success! Organization provisioned:`);
    console.log(`  Organization ID : ${result.organizationId}`);
    console.log(`  Store ID        : ${result.storeId} (code: ${storeCode})`);
    console.log(`  Owner User ID   : ${result.ownerUserId} (${username})`);
    console.log(`  Login           : ${login}`);
  } finally {
    await conn.close();
  }
}

// Auto-run if executed directly
if (process.argv[1]?.endsWith('create-org.ts') || process.argv[1]?.endsWith('create-org.js')) {
  runCreateOrgCli().catch((err) => {
    console.error(`[org:create] Fatal error:`, err);
    process.exit(1);
  });
}
