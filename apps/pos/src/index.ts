export const POS_APP_ID = '@mezon/pos';
export { normalizeLoopbackHubBaseUrl, type HubBridgeState, type MezonBridge } from './bridge.js';
export {
  DEFAULT_SCANNER_DETECTOR_CONFIG,
  INITIAL_SCANNER_DETECTOR_STATE,
  extractScannerCharacter,
  stepScannerDetector,
  computeRestoredInputValue,
} from './scanner/scanner-detector.js';
export type {
  ScannerDetectorConfig,
  ScannerDetectorState,
  ScannerKeyInput,
  ScannerStepOutcome,
} from './scanner/scanner-detector.js';
export { HubApiClient, HubApiError } from './api/hub-client.js';
export { generateBrowserUuidV7 } from './utils/browser-uuid.js';
