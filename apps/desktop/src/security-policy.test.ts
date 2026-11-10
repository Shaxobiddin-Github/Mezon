import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_HOME_URL,
  DESKTOP_FUSE_REQUIREMENTS,
  buildDesktopCspHeader,
  isAllowedNavigationUrl,
  resolveAppProtocolFilePath,
} from './security-policy.js';

describe('desktop security policy', () => {
  it('builds strict CSP without unsafe-inline or unsafe-eval and pins Hub origin', () => {
    const withoutHub = buildDesktopCspHeader(null);
    expect(withoutHub).toContain("script-src 'self' app://mezon");
    expect(withoutHub).toContain("connect-src 'self' app://mezon;");
    expect(withoutHub).not.toContain('unsafe-inline');
    expect(withoutHub).not.toContain('unsafe-eval');

    const withHub = buildDesktopCspHeader('http://127.0.0.1:49215');
    expect(withHub).toContain("connect-src 'self' app://mezon http://127.0.0.1:49215");

    expect(() => buildDesktopCspHeader('http://localhost:3000')).toThrow();
    expect(() => buildDesktopCspHeader('https://127.0.0.1:3000')).toThrow();
  });

  it('allows only app://mezon navigation and blocks external or file URLs', () => {
    expect(isAllowedNavigationUrl(APP_HOME_URL)).toBe(true);
    expect(isAllowedNavigationUrl('app://mezon/assets/index.js')).toBe(true);
    expect(isAllowedNavigationUrl('https://example.com/')).toBe(false);
    expect(isAllowedNavigationUrl('http://127.0.0.1:3000/')).toBe(false);
    expect(isAllowedNavigationUrl('file:///C:/Windows/System32/calc.exe')).toBe(false);
    expect(isAllowedNavigationUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedNavigationUrl('app://evil/')).toBe(false);
  });

  it('resolves UI assets inside uiRootDir only and blocks path traversal', () => {
    const uiRoot = path.resolve('dist-app', 'pos');
    expect(resolveAppProtocolFilePath('app://mezon/', uiRoot)).toBe(
      path.join(uiRoot, 'index.html'),
    );
    expect(resolveAppProtocolFilePath('app://mezon/assets/app.js', uiRoot)).toBe(
      path.join(uiRoot, 'assets', 'app.js'),
    );
    expect(resolveAppProtocolFilePath('app://mezon/../secret.txt', uiRoot)).toBeNull();
    expect(resolveAppProtocolFilePath('app://mezon/%2e%2e/secret.txt', uiRoot)).toBeNull();
    expect(resolveAppProtocolFilePath('app://mezon/index.html%00.png', uiRoot)).toBeNull();
    expect(resolveAppProtocolFilePath('file:///C:/index.html', uiRoot)).toBeNull();
  });

  it('requires locked-down production fuses', () => {
    expect(DESKTOP_FUSE_REQUIREMENTS).toEqual({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
    });
  });
});
