ARG TARGETPLATFORM=linux/amd64
FROM --platform=$TARGETPLATFORM node:20-bookworm-slim

RUN apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=20 update \
  && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    git ca-certificates unzip zip \
    make gcc g++ libc6-dev \
    libsdl1.2debian libfdt1 \
  && rm -rf /var/lib/apt/lists/*

# Install pebble-tool into a venv (not root ~/.local)
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir -U pip \
  && /opt/venv/bin/pip install --no-cache-dir pebble-tool

ENV PATH="/opt/venv/bin:${PATH}"

RUN useradd -m -u 10001 appuser
USER appuser
ENV HOME=/home/appuser
RUN pebble sdk install latest
USER root

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
  && corepack prepare pnpm@10.26.1 --activate \
  && pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

RUN pnpm build
RUN pebble --version

USER appuser
ENV HOME=/home/appuser
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "dist/server.js"]
