FROM node:20-bookworm-slim

ARG DEBIAN_MIRROR=deb.debian.org
ARG DEBIAN_SECURITY_MIRROR=deb.debian.org

RUN apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=20 update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    git \
    ca-certificates \
    unzip \
    zip \
    make \
    gcc \
    g++ \
    libc6-dev \
    libsdl1.2debian \
    libfdt1 \
  && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir uv \
  && uv tool install pebble-tool \
  && ln -s /root/.local/bin/pebble /usr/local/bin/pebble

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
  && corepack prepare pnpm@10.26.1 --activate \
  && pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

RUN pnpm build

RUN useradd -m -u 10001 appuser
USER appuser

ENV NODE_ENV=production

EXPOSE 8787

CMD ["node", "dist/server.js"]
