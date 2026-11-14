import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCloudConfig } from './config.js';

describe('Deploy & Security Debt Verification (T2.1 debt)', () => {
  it('ensures runtime loadCloudConfig does not parse or expose DATABASE_ADMIN_URL', () => {
    const config = loadCloudConfig({
      DATABASE_URL: 'postgres://mezon_app:secret@localhost:5432/mezon_cloud',
      DATABASE_ADMIN_URL: 'postgres://superuser:admin@localhost:5432/mezon_cloud',
      JWT_SECRET: 'super-secure-jwt-secret-key-at-least-32-chars-long-12345',
      NODE_ENV: 'test',
    });

    expect(config).not.toHaveProperty('databaseAdminUrl');
    expect(config.databaseUrl).toBe('postgres://mezon_app:secret@localhost:5432/mezon_cloud');
  });

  it('ensures docker-compose.yml does not pass DATABASE_ADMIN_URL to cloud service and isolates migrate', () => {
    const composePath = path.resolve(import.meta.dirname, '../../../deploy/docker-compose.yml');
    const content = fs.readFileSync(composePath, 'utf8');

    // Split cloud and migrate service blocks (indented by 2 spaces under services:)
    const cloudBlockMatch = content.match(/\n  cloud:\s*[\s\S]*?(?=\n  [a-z0-9_-]+:|\nvolumes:|\nnetworks:|$)/);
    expect(cloudBlockMatch).not.toBeNull();
    const cloudBlock = cloudBlockMatch![0];

    // Cloud service must NOT contain DATABASE_ADMIN_URL
    expect(cloudBlock).not.toContain('DATABASE_ADMIN_URL');
    // Cloud service must depend on migrate service completing successfully
    expect(cloudBlock).toContain('migrate:');
    expect(cloudBlock).toContain('service_completed_successfully');

    // Migrate service must exist and contain DATABASE_ADMIN_URL
    const migrateBlockMatch = content.match(/\n  migrate:\s*[\s\S]*?(?=\n  [a-z0-9_-]+:|\nvolumes:|\nnetworks:|$)/);
    expect(migrateBlockMatch).not.toBeNull();
    const migrateBlock = migrateBlockMatch![0];
    expect(migrateBlock).toContain('DATABASE_ADMIN_URL');
    expect(migrateBlock).toContain('db:migrate');
  });
});
