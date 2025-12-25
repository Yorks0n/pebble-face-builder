# Pebbleface Runner

A small HTTP service that accepts a Pebble watchface zip bundle, runs `pebble build`, and returns the resulting `.pbw` file.

## Requirements

- Docker (recommended for local use)
- Pebble CLI installed in the container (see Dockerfile). The image installs `uv` and runs `uv tool install pebble-tool` per the official instructions.

## Local Run (Docker)

```bash
docker build -t pebbleface-runner .
docker run --rm -p 8787:8787 -e PORT=8787 pebbleface-runner
```

## Build a Watchface

```bash
curl -F "bundle=@./watchface.zip" http://localhost:8787/build -o out.pbw
```

## Health Check

```bash
curl http://localhost:8787/healthz
```

## API

### GET /healthz

Returns `ok`.

### POST /build

Multipart upload (required field name: `bundle`). Optional fields: `target`, `timeoutSec`, `maxZipBytes`, `maxUnzipBytes`.
The `target` value is passed as `pebble build --target <target>`.

Response:
- `200` with `.pbw` binary
- Headers: `X-Job-Id`, `X-Build-Log-Base64`

Errors:
- `400` invalid request or zip
- `413` too large
- `429` concurrency limit
- `500` build failed
- `504` timeout

### Optional JSON

```json
{
  "bundleUrl": "https://example.com/bundle.zip",
  "target": "basalt",
  "timeoutSec": 120,
  "maxZipBytes": 26214400,
  "maxUnzipBytes": 104857600
}
```

## Configuration

Environment variables:

- `PORT` (default: 8787)
- `MAX_CONCURRENCY` (default: 1)
- `BUILD_TIMEOUT_SEC` (default: 120)
- `MAX_ZIP_BYTES` (default: 26214400)
- `MAX_UNZIP_BYTES` (default: 104857600)

## Notes

- The service only runs `pebble build` and ignores any scripts in the bundle.
- Zip-slip and unzip size limits are enforced before building.
- If you need a specific CLI version, update the Dockerfile to install a pinned `pebble-tool` version via `uv tool install`.
