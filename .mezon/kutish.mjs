// Claude'ning yangi topshirig'ini kutadi: node .mezon/kutish.mjs [daqiqa]
// Joriy branch'da `.mezon/claude/TOPSHIRIQ.md` ni o'zgartirgan yangi commit paydo bo'lishini kuzatadi.
import { execFileSync } from 'node:child_process';

const FILE = '.mezon/claude/TOPSHIRIQ.md';
const maxMinutes = Number(process.argv[2] ?? 120);

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function lastSha(ref) {
  try {
    return git('log', '-1', '--format=%H', ref, '--', FILE);
  } catch {
    return '';
  }
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const baseline = lastSha('HEAD');
const started = Date.now();
console.log(`Kutilmoqda: "${branch}" branch'ida Claude'ning yangi topshirig'i (eng ko'pi ${maxMinutes} daqiqa).`);

while (Date.now() - started < maxMinutes * 60_000) {
  try {
    git('fetch', '-q', 'origin', branch);
  } catch {
    // tarmoq xatosi: keyingi urinishda qayta tekshiriladi
  }
  const remote = lastSha(`origin/${branch}`);
  if (remote && remote !== baseline) {
    try {
      git('merge', '--ff-only', `origin/${branch}`);
      console.log('Lokal branch yangilandi (fast-forward).');
    } catch {
      console.log("DIQQAT: fast-forward bo'lmadi (lokal o'zgarish bor). Avval commit qil, keyin `git pull --ff-only`.");
    }
    console.log(`YANGI TOPSHIRIQ KELDI (${remote.slice(0, 7)}):\n`);
    console.log(git('show', `origin/${branch}:${FILE}`));
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}

console.log("VAQT TUGADI: Claude javobi kelmadi. Skriptni qayta ishga tushir (.mezon/ALOQA.md, 6-band).");
process.exit(2);
