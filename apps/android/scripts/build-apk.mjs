// Builds the Android APK: assemble www, sync Capacitor, then Gradle.
// Needs JDK 21 (JAVA_HOME) and the Android SDK (ANDROID_HOME or android/local.properties).
// Usage: pnpm --filter @mezon/android apk [debug|release]
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const variant = process.argv[2] === 'release' ? 'release' : 'debug';
const win = process.platform === 'win32';
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: win });

run('node', ['scripts/assemble-www.mjs'], root);
run('npx', ['cap', 'sync', 'android'], root);
run(
  win ? 'gradlew.bat' : './gradlew',
  [variant === 'release' ? 'assembleRelease' : 'assembleDebug'],
  join(root, 'android'),
);
console.log(`APK: ${join(root, 'android', 'app', 'build', 'outputs', 'apk', variant)}`);
