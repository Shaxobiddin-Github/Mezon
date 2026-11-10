export const HUB_APP = '@mezon/hub';

export { DEFAULT_HUB_HOST, DEFAULT_HUB_PORT, resolveHubSecurityConfig } from './config.js';
export { HUB_LOGGER_REDACT_PATHS, createHubLogger, type CreateHubLoggerOptions } from './logger.js';
export { Argon2PinHasher, HUB_ARGON2_OPTIONS, ARGON2ID_PHC_PREFIX } from './argon2-pin-hasher.js';
export { HubAuthService, hashBearerToken, extractBearerToken } from './auth-service.js';
export { HubCatalogService } from './catalog-service.js';
export { HubStockService } from './stock-service.js';
export { HubCartService } from './cart-service.js';
export { HubSaleService } from './sale-service.js';
export { createHubServer, type CreateHubServerOptions, type HubServer } from './server.js';
