# OpenWA - Dockerfile
# Multi-stage build optimized for fast CI/CD builds (Coolify-compatible)

# ===== Stage 1: Builder =====
FROM node:22-slim AS builder

WORKDIR /app

# Install build dependencies (--no-install-recommends saves ~100MB)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN NODE_ENV=development npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# ===== Stage 2: Production =====
# Using official Puppeteer image eliminates the slow chromium apt-get install
# (saves ~3-5 minutes and ~600MB vs installing chromium from apt)
FROM ghcr.io/puppeteer/puppeteer:24 AS production

USER root

# Install only dumb-init for proper signal handling (~1 second)
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Chrome is pre-installed in the puppeteer image
# Set the cache dir so puppeteer can find it (image default user is pptruser)
ENV PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Create data directories with proper permissions
RUN mkdir -p ./data/sessions ./data/media && \
    chown -R root:root /app

# Note: Running as root to allow Docker socket access for orchestration
# For production with stricter security, consider using a Docker socket proxy

# Expose port
EXPOSE 2785

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "require('http').get('http://localhost:2785/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start with dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main"]
