import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CloudLicenceStore, createCloudPgPool } from '@mezon/db-cloud';
import {
  MonotonicUuidV7Generator,
  type UnixMs,
  type UuidV7,
  parseUuidV7,
  unixMsFromBigInt,
} from '@mezon/domain';
import {
  PLAN_CATALOG,
  PRODUCTION_TRUSTED_LICENCE_KEYS,
  type TrustedLicenceKey,
  verifyLicence,
} from '@mezon/licensing';
import { loadCloudConfig } from '../config.js';
import { CloudLicenceService, nodeEd25519LicenceVerifier } from '../licence-service.js';

/**
 * T4.7 operations (platform owner):
 *   licence:import  --file <licence.json>      verify against the trusted keys, then store
 *   licence:invoice --org <uuid> --period YYYY-MM   issue the month's platform invoice (idempotent)
 *   licence:paid    --org <uuid> --period YYYY-MM   mark it paid
 * Licence signing itself happens offline: `scripts/licence-sign.mjs`.
 */
export async function runLicenceCommand(
  command: string,
  args: Record<string, string>,
  deps: {
    readonly pool: ReturnType<typeof createCloudPgPool>['pool'];
    readonly trustedKeys?: readonly TrustedLicenceKey[];
    readonly nowMs?: UnixMs;
    readonly log?: (line: string) => void;
  },
): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const nowMs = deps.nowMs ?? unixMsFromBigInt(BigInt(Date.now()));
  const idGen = new MonotonicUuidV7Generator({
    clock: { now: () => unixMsFromBigInt(BigInt(Date.now())) },
    random: { nextBytes: (n: number) => randomBytes(n) },
  });
  const store = new CloudLicenceStore(deps.pool, idGen);
  const keys = deps.trustedKeys ?? PRODUCTION_TRUSTED_LICENCE_KEYS;

  if (command === 'import') {
    const raw: unknown = JSON.parse(fs.readFileSync(required(args, 'file'), 'utf8'));
    const org = (raw as { payload?: { organizationId?: string } }).payload?.organizationId ?? '';
    const env = verifyLicence(raw, org, keys, nodeEd25519LicenceVerifier);
    const saved = await store.saveLicence({
      organizationId: parseUuidV7(env.payload.organizationId),
      licenceId: env.payload.licenceId,
      plan: env.payload.plan,
      envelope: raw,
      validFromMs: env.payload.validFromMs,
      validUntilMs: env.payload.validUntilMs,
      nowMs,
    });
    log(
      saved ? `imported ${env.payload.plan} licence ${env.payload.licenceId}` : 'already imported',
    );
    return;
  }

  const org: UuidV7 = parseUuidV7(required(args, 'org'));
  const period = required(args, 'period');
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('--period must be YYYY-MM');

  if (command === 'invoice') {
    const status = await new CloudLicenceService(store, keys).getStatus(org, nowMs);
    if (status.plan === null || status.state === 'expired') {
      throw new Error(`No billable licence (state ${status.state})`);
    }
    const issued = await store.issueInvoice({
      organizationId: org,
      period,
      plan: status.plan,
      amountTiyin: PLAN_CATALOG[status.plan].monthlyPriceTiyin,
      nowMs,
    });
    log(issued ? `invoice ${period} issued (${status.plan})` : `invoice ${period} already exists`);
    return;
  }
  if (command === 'paid') {
    const ok = await store.markInvoicePaid(org, period, nowMs);
    log(ok ? `invoice ${period} marked paid` : `no issued invoice for ${period}`);
    return;
  }
  throw new Error(`Unknown command "${command}" (import | invoice | paid)`);
}

function required(args: Record<string, string>, name: string): string {
  const v = args[name];
  if (!v) throw new Error(`Missing --${name}`);
  return v;
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a?.startsWith('--') && v !== undefined) {
      out[a.slice(2)] = v;
      i += 1;
    }
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = loadCloudConfig();
  const conn = createCloudPgPool({ connectionString: config.databaseUrl });
  runLicenceCommand(process.argv[2] ?? '', parseArgs(process.argv.slice(3)), { pool: conn.pool })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    })
    .finally(() => {
      void conn.close();
    });
}
