# OpenWA - Dockerfile
# Multi-stage build for production-ready image

# ===== Stage 1: Builder =====
FROM --platform=$BUILDPLATFORM docker.io/node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS builder

WORKDIR /app

ENV NODE_OPTIONS="--max-old-space-size=2048"

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files for both root and dashboard to leverage Docker layer caching
COPY package*.json ./
COPY scripts/postinstall.js ./scripts/
COPY dashboard/package*.json ./dashboard/

# Install root dependencies
RUN npm ci --include=dev

# Install dashboard dependencies (cached layer)
RUN cd dashboard && npm ci --include=dev

# Copy source code
COPY . .

# Build the API (dist/) and the dashboard SPA (dashboard/dist/)
RUN npm run build && npm run dashboard:build && rm -f dist/*.tsbuildinfo

# ===== Stage 2: Production =====
FROM docker.io/node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS production

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

ARG TARGETARCH

# Install runtime system dependencies in a single consolidated, cached RUN
COPY scripts/pgdg-ACCC4CF8.asc /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
RUN echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    $([ "$TARGETARCH" = arm64 ] && echo "chromium chromium-sandbox") \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    dumb-init \
    gosu \
    patch \
    curl \
    procps \
    sqlite3 \
    ffmpeg \
    postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*

# Create app user for security
RUN groupadd -r openwa && useradd -r -g openwa openwa

WORKDIR /app

# Copy package files & patchers
COPY package*.json ./
COPY scripts/postinstall.js scripts/patch-wwebjs-201832.js scripts/wwebjs-201832.patch scripts/patch-wwebjs-newsletter-preview.js scripts/patch-wwebjs-status.js scripts/patch-wwebjs-ready-sync.js scripts/patch-wwebjs-participant-arity.js scripts/patch-wwebjs-block.js scripts/patch-baileys-appstate.js scripts/patch-baileys-newsletter-create.js ./scripts/

# Install production dependencies only, then apply the backports
RUN npm ci --omit=dev --ignore-scripts \
    && node scripts/patch-wwebjs-201832.js \
    && node scripts/patch-wwebjs-newsletter-preview.js \
    && node scripts/patch-wwebjs-status.js \
    && node scripts/patch-wwebjs-ready-sync.js \
    && node scripts/patch-wwebjs-participant-arity.js \
    && node scripts/patch-wwebjs-block.js \
    && node scripts/patch-baileys-appstate.js \
    && node scripts/patch-baileys-newsletter-create.js \
    && npm cache clean --force

# amd64: download Chrome for Testing via Puppeteer and symlink it.
# arm64: use Debian's chromium installed above (CfT has no linux-arm64 build).
RUN if [ "$TARGETARCH" = arm64 ]; then \
        ln -s /usr/bin/chromium /usr/local/bin/puppeteer-chrome; \
    else \
        mkdir -p /opt/puppeteer && \
        PUPPETEER_CACHE_DIR=/opt/puppeteer ./node_modules/.bin/puppeteer browsers install 'chrome@146.0.7680.31' && \
        chown -R openwa:openwa /opt/puppeteer && \
        chrome_path=$(find /opt/puppeteer/chrome/linux*/chrome-linux64/chrome | head -n 1) && \
        test -n "$chrome_path" && \
        ln -s "$chrome_path" /usr/local/bin/puppeteer-chrome; \
    fi
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/puppeteer-chrome

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dashboard/dist ./dashboard/dist

# Create data directories with correct ownership
RUN mkdir -p ./data/sessions ./data/media ./data/plugins && \
    chown -R openwa:openwa ./data

ENV HOME=/app/data
ENV XDG_CONFIG_HOME=/tmp/.config
ENV XDG_CACHE_HOME=/tmp/.cache

# Operator backup/restore scripts
COPY scripts/backup.sh scripts/restore.sh scripts/lib-env.sh ./scripts/

# Copy entrypoint
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 2785

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:2785/api/health/ready || exit 1

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/main"]
