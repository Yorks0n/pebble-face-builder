import { spawn } from 'node:child_process';

const LOG_LIMIT_BYTES = 200 * 1024;

export class BuildTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildTimeoutError';
  }
}

export class BuildFailedError extends Error {
  log: string;

  constructor(message: string, log: string) {
    super(message);
    this.name = 'BuildFailedError';
    this.log = log;
  }
}

export interface BuildResult {
  log: string;
}

const appendLog = (buffer: Buffer[], chunk: Buffer, state: { size: number }) => {
  if (state.size >= LOG_LIMIT_BYTES) {
    return;
  }
  const remaining = LOG_LIMIT_BYTES - state.size;
  const slice = chunk.subarray(0, remaining);
  buffer.push(slice);
  state.size += slice.length;
};

export async function runPebbleBuild(
  cwd: string,
  target: string | undefined,
  timeoutMs: number
): Promise<BuildResult> {
  const args = ['build'];
  if (target) {
    args.push('--target', target);
  }

  const logChunks: Buffer[] = [];
  const logState = { size: 0 };

  return new Promise<BuildResult>((resolve, reject) => {
    let settled = false;
    const child = spawn('pebble', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });

    const timeout = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        child.kill('SIGKILL');
      }
      if (!settled) {
        settled = true;
        reject(new BuildTimeoutError('build timed out'));
      }
    }, timeoutMs);

    const onData = (chunk: Buffer) => appendLog(logChunks, chunk, logState);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('error', (err: Error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      const log = Buffer.concat(logChunks).toString('utf8');
      if (settled) return;
      settled = true;
      if (signal || code !== 0) {
        reject(new BuildFailedError(`pebble build failed (${signal ?? code})`, log));
        return;
      }
      resolve({ log });
    });
  });
}
