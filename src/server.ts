import busboy from 'busboy';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { findPbw } from './build/find-pbw.js';
import { runPebbleBuild, BuildFailedError, BuildTimeoutError } from './build/run.js';
import { safeExtractZip, UnzipLimitError, ZipSlipError } from './build/unzip.js';

const PORT = Number(process.env.PORT || 8787);
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 1);
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 10);
const DEFAULT_AVG_BUILD_SEC = Number(process.env.DEFAULT_AVG_BUILD_SEC || 60);
const DEFAULT_TIMEOUT_SEC = Number(process.env.BUILD_TIMEOUT_SEC || 120);
const DEFAULT_MAX_ZIP_BYTES = Number(process.env.MAX_ZIP_BYTES || 25 * 1024 * 1024);
const DEFAULT_MAX_UNZIP_BYTES = Number(process.env.MAX_UNZIP_BYTES || 100 * 1024 * 1024);

const app = express();

app.use(express.json({ limit: '1mb', type: ['application/json'] }));
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.info(`[request] ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });
  next();
});

let activeBuilds = 0;
let avgBuildMs = DEFAULT_AVG_BUILD_SEC * 1000;
let buildSamples = 0;
type QueueEntry = {
  resolve: () => void;
  reject: (err: Error) => void;
  canceled: boolean;
};
const queue: QueueEntry[] = [];

const parseNumber = (value: unknown, fallback: number) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return num;
};

const estimateRetryAfterSec = () => {
  if (MAX_CONCURRENCY <= 0) return DEFAULT_AVG_BUILD_SEC;
  const position = queue.length + activeBuilds;
  const estimateMs = (position / MAX_CONCURRENCY) * avgBuildMs;
  return Math.max(1, Math.ceil(estimateMs / 1000));
};

const readLimitedStreamToFile = async (
  stream: NodeJS.ReadableStream,
  filePath: string,
  maxBytes: number
) => {
  let bytes = 0;
  const limiter = new TransformLimiter(maxBytes, (size) => {
    bytes = size;
  });
  await pipeline(stream, limiter, createWriteStream(filePath));
  return bytes;
};

class TransformLimiter extends Transform {
  private readonly maxBytes: number;
  private readonly onUpdate: (size: number) => void;
  private total = 0;

  constructor(maxBytes: number, onUpdate: (size: number) => void) {
    super();
    this.maxBytes = maxBytes;
    this.onUpdate = onUpdate;
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
    this.total += chunk.length;
    this.onUpdate(this.total);
    if (this.total > this.maxBytes) {
      callback(new Error('zip exceeds size limit'));
      return;
    }
    callback(null, chunk);
  }
}

const handleMultipart = async (
  req: express.Request,
  zipPath: string,
  maxZipBytes: number
): Promise<{ fields: Record<string, string>; bytes: number }> => {
  const fields: Record<string, string> = {};
  let bytes = 0;
  let filePromise: Promise<void> | null = null;
  let fileSeen = false;
  let finished = false;

  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      if (finished) return;
      finished = true;
      if (err) {
        reject(err);
      }
    };

    const bb = busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fileSize: maxZipBytes
      }
    });

    bb.on('field', (name: string, value: string) => {
      fields[name] = value;
    });

    bb.on('file', (name: string, file: NodeJS.ReadableStream) => {
      if (name !== 'bundle') {
        file.resume();
        return;
      }
      fileSeen = true;
      const limiter = new TransformLimiter(maxZipBytes, (size) => {
        bytes = size;
      });

      file.on('limit', () => {
        limiter.destroy(new Error('zip exceeds size limit'));
      });

      filePromise = pipeline(file, limiter, createWriteStream(zipPath)).catch((err: Error) => {
        bb.destroy(err as Error);
        throw err;
      });
    });

    bb.on('error', (err: Error) => done(err));

    bb.on('finish', async () => {
      try {
        if (!fileSeen) {
          done(new Error('missing_bundle'));
          return;
        }
        if (filePromise) {
          await filePromise;
        }
        if (!finished) {
          finished = true;
          resolve({ fields, bytes });
        }
      } catch (err) {
        done(err as Error);
      }
    });

    req.pipe(bb);
  });
};

app.get('/healthz', (_req: express.Request, res: express.Response) => {
  res.status(200).send('ok');
});

app.post('/build', async (req: express.Request, res: express.Response) => {
  const jobId = randomUUID();
  let acquired = false;
  let buildStart = 0;
  res.setHeader('X-Job-Id', jobId);

  const jobRoot = path.join('/tmp/pebbleface', jobId);
  const workDir = path.join(jobRoot, 'work');
  const zipPath = path.join(jobRoot, 'bundle.zip');

  try {
    try {
      await acquireSlot(req);
      acquired = true;
      buildStart = Date.now();
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'queue_full') {
        res.setHeader('Retry-After', estimateRetryAfterSec().toString());
        res.status(429).json({ ok: false, error: 'too_many_requests', detail: 'queue limit reached' });
        return;
      }
      return;
    }

    await fs.mkdir(jobRoot, { recursive: true });

    const query = req.query as Record<string, string | undefined>;
    let target: string | undefined = query.target;
    let timeoutSec = parseNumber(query.timeoutSec, DEFAULT_TIMEOUT_SEC);
    let maxZipBytes = parseNumber(query.maxZipBytes, DEFAULT_MAX_ZIP_BYTES);
    let maxUnzipBytes = parseNumber(query.maxUnzipBytes, DEFAULT_MAX_UNZIP_BYTES);

    const contentType = req.headers['content-type'] ?? '';

    if (contentType.includes('multipart/form-data')) {
      const contentLength = req.headers['content-length'];
      if (contentLength && Number(contentLength) > maxZipBytes) {
        res.status(413).json({ ok: false, error: 'zip_too_large', detail: 'zip exceeds size limit' });
        return;
      }

      let fields: Record<string, string> = {};
      let bytes = 0;
      try {
        const result = await handleMultipart(req, zipPath, maxZipBytes);
        fields = result.fields;
        bytes = result.bytes;
      } catch (err) {
        const message = (err as Error).message;
        if (message === 'missing_bundle') {
          res.status(400).json({ ok: false, error: 'missing_bundle', detail: 'multipart field "bundle" required' });
          return;
        }
        res.status(413).json({ ok: false, error: 'zip_too_large', detail: 'zip exceeds size limit' });
        return;
      }

      if (typeof fields.target === 'string') {
        target = fields.target;
      }
      timeoutSec = parseNumber(fields.timeoutSec, timeoutSec);
      maxUnzipBytes = parseNumber(fields.maxUnzipBytes, maxUnzipBytes);

      const overrideMaxZipBytes = parseNumber(fields.maxZipBytes, maxZipBytes);
      if (overrideMaxZipBytes < bytes) {
        res.status(413).json({ ok: false, error: 'zip_too_large', detail: 'zip exceeds size limit' });
        return;
      }
      maxZipBytes = overrideMaxZipBytes;
    } else if (contentType.includes('application/json')) {
      const body = req.body as { bundleUrl?: string; target?: string; timeoutSec?: number; maxZipBytes?: number; maxUnzipBytes?: number };
      if (!body?.bundleUrl) {
        res.status(400).json({ ok: false, error: 'missing_bundle', detail: 'bundleUrl required' });
        return;
      }

      target = body.target ?? target;
      timeoutSec = parseNumber(body.timeoutSec, timeoutSec);
      maxZipBytes = parseNumber(body.maxZipBytes, maxZipBytes);
      maxUnzipBytes = parseNumber(body.maxUnzipBytes, maxUnzipBytes);

      const response = await fetch(body.bundleUrl);
      if (!response.ok || !response.body) {
        res.status(400).json({ ok: false, error: 'bundle_download_failed', detail: 'unable to download bundleUrl' });
        return;
      }

      const length = response.headers.get('content-length');
      if (length && Number(length) > maxZipBytes) {
        res.status(413).json({ ok: false, error: 'zip_too_large', detail: 'zip exceeds size limit' });
        return;
      }

      try {
        const bodyStream = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
        await readLimitedStreamToFile(bodyStream, zipPath, maxZipBytes);
      } catch {
        res.status(413).json({ ok: false, error: 'zip_too_large', detail: 'zip exceeds size limit' });
        return;
      }
    } else {
      res.status(400).json({ ok: false, error: 'invalid_content_type', detail: 'multipart or json required' });
      return;
    }

    try {
      await safeExtractZip(zipPath, workDir, maxUnzipBytes);
    } catch (err) {
      if (err instanceof UnzipLimitError) {
        res.status(413).json({ ok: false, error: 'unzip_too_large', detail: err.message });
        return;
      }
      if (err instanceof ZipSlipError) {
        res.status(400).json({ ok: false, error: 'zip_slip', detail: err.message });
        return;
      }
      res.status(400).json({ ok: false, error: 'unzip_failed', detail: (err as Error).message });
      return;
    }

    let log = '';
    try {
      const result = await runPebbleBuild(workDir, target, timeoutSec * 1000);
      log = result.log;
      console.info(`[build] jobId=${jobId} log=${log}`);
    } catch (err) {
      if (err instanceof BuildTimeoutError) {
        console.warn(`[build] jobId=${jobId} timeout`);
        res.status(504).json({ ok: false, error: 'build_timeout', detail: err.message });
        return;
      }
      if (err instanceof BuildFailedError) {
        console.warn(`[build] jobId=${jobId} failed log=${err.log}`);
        res.status(500).json({ ok: false, error: 'build_failed', detail: err.message });
        return;
      }
      console.warn(`[build] jobId=${jobId} failed detail=${(err as Error).message}`);
      res.status(500).json({ ok: false, error: 'build_failed', detail: (err as Error).message });
      return;
    }

    const pbwPath = await findPbw(workDir);
    if (!pbwPath) {
      res.status(500).json({ ok: false, error: 'pbw_not_found', detail: 'build completed but no .pbw found' });
      return;
    }

    const pbwBuffer = await fs.readFile(pbwPath);
    const logBase64 = Buffer.from(log).toString('base64');

    res
      .status(200)
      .setHeader('Content-Type', 'application/octet-stream')
      .setHeader('Content-Disposition', 'attachment; filename="watchface.pbw"')
      .setHeader('X-Build-Log-Base64', logBase64)
      .send(pbwBuffer);
  } finally {
    if (buildStart > 0) {
      const duration = Date.now() - buildStart;
      buildSamples += 1;
      const alpha = 0.2;
      avgBuildMs = buildSamples === 1 ? duration : avgBuildMs * (1 - alpha) + duration * alpha;
    }
    if (acquired) {
      releaseSlot();
    }
    await fs.rm(jobRoot, { recursive: true, force: true });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`pebbleface-runner listening on :${PORT}`);
});
const acquireSlot = (req: express.Request) => {
  if (activeBuilds < MAX_CONCURRENCY) {
    activeBuilds += 1;
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    if (queue.length >= MAX_QUEUE) {
      reject(new Error('queue_full'));
      return;
    }

    const entry: QueueEntry = {
      resolve: () => {
        if (entry.canceled) return;
        activeBuilds += 1;
        resolve();
      },
      reject,
      canceled: false
    };

    const onClose = () => {
      if (entry.canceled) return;
      const index = queue.indexOf(entry);
      if (index !== -1) {
        queue.splice(index, 1);
      }
      entry.canceled = true;
      reject(new Error('client_disconnected'));
    };

    req.on('close', onClose);
    queue.push(entry);
  });
};

const releaseSlot = () => {
  activeBuilds = Math.max(activeBuilds - 1, 0);
  while (queue.length) {
    const next = queue.shift();
    if (!next || next.canceled) continue;
    next.resolve();
    break;
  }
};
