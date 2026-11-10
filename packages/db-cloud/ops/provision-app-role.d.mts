import type pg from 'pg';

export declare const DEFAULT_APP_ROLE_NAME: 'mezon_app';
export declare const DEFAULT_APP_PASSWORD_ENV: 'MEZON_APP_DB_PASSWORD';

export interface ProvisionAppRoleOptions {
  readonly pool: pg.Pool;
  readonly roleName?: string;
  readonly passwordEnvVar?: string;
}

export declare function provisionAppRole(options: ProvisionAppRoleOptions): Promise<void>;
