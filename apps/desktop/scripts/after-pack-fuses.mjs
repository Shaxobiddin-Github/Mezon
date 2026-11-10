import fs from 'node:fs';
import path from 'node:path';
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') {
    throw new Error(
      `Unexpected electronPlatformName in afterPack: ${context.electronPlatformName}`,
    );
  }

  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  if (!fs.existsSync(exePath)) {
    throw new Error(`Expected packed Electron executable at ${exePath}`);
  }

  await flipFuses(exePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });

  console.log(`Applied Electron fuses to ${exePath}`);
}
