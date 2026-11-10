export const DESKTOP_APP = '@mezon/desktop';
export {
  createProcessDesktopDataDir,
  resolveDesktopDataDir,
  resolveDesktopLayoutPaths,
  resolveRuntimeAssetPaths,
  type DesktopLayoutPaths,
  type ResolveDesktopDataDirInput,
  type RuntimeAssetPaths,
} from './paths.js';
export {
  APP_HOME_URL,
  APP_HOST,
  APP_ORIGIN,
  APP_SCHEME,
  DESKTOP_FUSE_REQUIREMENTS,
  buildDesktopCspHeader,
  getMimeTypeForPath,
  isAllowedNavigationUrl,
  isPathInsideRoot,
  parseLoopbackHubOrigin,
  resolveAppProtocolFilePath,
} from './security-policy.js';
export {
  HubSupervisor,
  selectRestartBackoffMs,
  type HubBridgeState,
  type HubChildProcessLike,
  type HubSupervisorDeps,
} from './hub-supervisor.js';
