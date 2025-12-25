import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';

export class UnzipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnzipLimitError';
  }
}

export class ZipSlipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipSlipError';
  }
}

const normalizeRoot = async (dir: string) => {
  await fs.mkdir(dir, { recursive: true });
  return fs.realpath(dir);
};

export async function safeExtractZip(
  zipPath: string,
  destDir: string,
  maxUnzipBytes: number
): Promise<void> {
  const root = await normalizeRoot(destDir);
  let totalBytes = 0;
  let finished = false;

  const failOnce = (reject: (err: Error) => void, err: Error) => {
    if (finished) return;
    finished = true;
    reject(err);
  };

  await new Promise<void>((resolve, reject) => {
    const entries: Promise<void>[] = [];
    const stream = createReadStream(zipPath).pipe(unzipper.Parse());

    stream.on('entry', (entry: unzipper.Entry) => {
      stream.pause();
      if (finished) {
        entry.autodrain();
        stream.resume();
        return;
      }

      const entryPath = entry.path || '';
      const resolvedPath = path.resolve(root, entryPath);
      const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
      const task = (async () => {
        if (resolvedPath !== root && !resolvedPath.startsWith(rootPrefix)) {
          entry.autodrain();
          throw new ZipSlipError(`zip entry escapes target: ${entryPath}`);
        }

        if (entry.type === 'SymbolicLink') {
          entry.autodrain();
          return;
        }

        if (entry.type === 'Directory') {
          await fs.mkdir(resolvedPath, { recursive: true });
          entry.autodrain();
          return;
        }

      const sizeHint = (entry as unknown as { vars?: { uncompressedSize?: number } }).vars?.uncompressedSize ?? 0;
        if (sizeHint > 0 && totalBytes + sizeHint > maxUnzipBytes) {
          entry.autodrain();
          throw new UnzipLimitError('unzipped data exceeds limit');
        }

        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        const limiter = new SizeLimiter(totalBytes, maxUnzipBytes);
        await pipeline(entry, limiter, createWriteStream(resolvedPath));
        totalBytes = limiter.totalBytes;
      })()
        .catch((err: Error) => {
          if (!finished) {
            stream.destroy();
            failOnce(reject, err as Error);
          }
          throw err;
        })
        .finally(() => {
          if (!finished) stream.resume();
        });
      entries.push(task);
    });

    stream.on('close', () => {
      if (finished) return;
      Promise.all(entries)
        .then(() => {
          finished = true;
          resolve();
        })
        .catch((err) => failOnce(reject, err as Error));
    });

    stream.on('error', (err: Error) => failOnce(reject, err));
  });
}

class SizeLimiter extends Transform {
  totalBytes: number;
  private readonly maxBytes: number;

  constructor(initialBytes: number, maxBytes: number) {
    super();
    this.totalBytes = initialBytes;
    this.maxBytes = maxBytes;
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
    this.totalBytes += chunk.length;
    if (this.totalBytes > this.maxBytes) {
      callback(new UnzipLimitError('unzipped data exceeds limit'));
      return;
    }
    callback(null, chunk);
  }
}
