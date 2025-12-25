# Pebbleface Runner

Pebbleface Runner is a small HTTP service that accepts a Pebble watchface zip bundle, runs `pebble build`, and returns the resulting `.pbw` file.

## Quick Start (Docker)

```bash
docker build -t pebbleface-runner .
docker run --rm -p 8787:8787 -e PORT=8787 pebbleface-runner
```

Apple Silicon note (pebble-tool pulls arm64 deps that can fail to build):

```bash
docker buildx build --platform linux/amd64 -t pebbleface-runner .
```

## Render Deployment (Docker)

Render Native Node builds cannot run `apt-get`, so this service must be deployed as Docker.

1. Set Environment to Docker in Render.
2. Clear Build Command / Start Command (Dockerfile handles both).
3. Deploy.

## Usage

Build a watchface:

```bash
curl -F "bundle=@./watchface.zip" http://localhost:8787/build -o out.pbw
```

Health check:

```bash
curl http://localhost:8787/healthz
```

If `RUNNER_TOKEN` is configured on the server, include `X-Runner-Token`:

```bash
curl -F "bundle=@./watchface.zip" -H "X-Runner-Token: <token>" http://localhost:8787/build -o out.pbw
```

## API

### GET /healthz

- `200 OK`
- Body: `ok`

### POST /build

Accepted content types:
- `multipart/form-data` (recommended)
- `application/json` (bundle URL)

Multipart fields:
- `bundle` (required, zip file)
- `target` (optional)
- `timeoutSec` (optional)
- `maxZipBytes` (optional)
- `maxUnzipBytes` (optional)

JSON body:

```json
{
  "bundleUrl": "https://example.com/bundle.zip",
  "target": "basalt",
  "timeoutSec": 120,
  "maxZipBytes": 26214400,
  "maxUnzipBytes": 104857600
}
```

Success response:
- `200 OK`
- `Content-Type: application/octet-stream`
- `Content-Disposition: attachment; filename="watchface.pbw"`
- Headers: `X-Job-Id`, `X-Build-Log-Base64`
- Body: `.pbw` binary

Error response (JSON):

```json
{ "ok": false, "error": "...", "detail": "..." }
```

Status codes:
- `400` invalid request or zip
- `413` too large
- `429` concurrency/queue limit (includes `Retry-After`)
- `500` build failed or pbw not found
- `504` timeout

## Configuration

Environment variables:

- `PORT` (default: 8787)
- `MAX_CONCURRENCY` (default: 1)
- `MAX_QUEUE` (default: 10)
- `DEFAULT_AVG_BUILD_SEC` (default: 60)
- `RUNNER_TOKEN` (optional, requires `X-Runner-Token`)
- `BUILD_TIMEOUT_SEC` (default: 120)
- `MAX_ZIP_BYTES` (default: 26214400)
- `MAX_UNZIP_BYTES` (default: 104857600)

## Notes

- The service only runs `pebble build` and ignores any scripts in the bundle.
- Zip-slip protection and unzip size limits are enforced.
- Excess requests are queued up to `MAX_QUEUE`, then return 429 with a dynamic `Retry-After`.
- To pin a Pebble CLI version, update the Dockerfile to install a specific `pebble-tool` version.
