// Build the Telemost browser image. The GitHub Actions cache is one shared
// scope, so an unchanged Dockerfile reuses the Chromium layer instead of
// installing it again. If the build prints nothing for several minutes, stop.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const CACHE_SCOPE = 'tg2tm-browser';
export const STALL_MS = 4 * 60 * 1000;

export function buildArgs() {
  return [
    'buildx', 'build',
    '--cache-from', `type=gha,scope=${CACHE_SCOPE}`,
    '--cache-to', `type=gha,mode=max,ignore-error=true,scope=${CACHE_SCOPE}`,
    '--file', 'vm/Dockerfile',
    '--tag', 'tg2tm-browser',
    '--load',
    '--progress=plain',
    '.',
  ];
}

export function stallWatch({
  stallMs,
  now = () => Date.now(),
  onStall,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let last = now();
  let timer;
  let stopped = false;
  const arm = () => {
    clearTimer(timer);
    if (stopped) return;
    const wait = Math.max(0, stallMs - (now() - last));
    timer = setTimer(() => {
      if (stopped) return;
      if (now() - last >= stallMs) onStall();
      else arm();
    }, wait);
  };
  return {
    progress() {
      last = now();
      arm();
    },
    start() {
      arm();
    },
    stop() {
      stopped = true;
      clearTimer(timer);
    },
  };
}

export function runWatched(child, { stallMs, write = (chunk) => process.stdout.write(chunk), now } = {}) {
  return new Promise((resolve, reject) => {
    let failed = false;
    const watch = stallWatch({
      stallMs,
      now,
      onStall: () => {
        if (failed) return;
        failed = true;
        watch.stop();
        child.kill('SIGTERM');
        reject(new Error(`no build progress for ${Math.round(stallMs / 1000)} seconds`));
      },
    });
    const onData = (chunk) => {
      write(chunk);
      watch.progress();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      watch.stop();
      if (!failed) reject(err);
    });
    child.on('close', (code) => {
      watch.stop();
      if (failed) return;
      if (code === 0) resolve();
      else reject(new Error(`build exited ${code}`));
    });
    watch.start();
  });
}

async function main() {
  const stallMs = Number(process.env.BUILD_STALL_MS || STALL_MS);
  const child = spawn('docker', buildArgs(), { stdio: ['ignore', 'pipe', 'pipe'] });
  await runWatched(child, { stallMs });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
