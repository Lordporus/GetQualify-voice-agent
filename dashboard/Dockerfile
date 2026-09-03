# =============================================================================
# Stage 1: Build assets (compile React charts with esbuild)
# =============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Enable pnpm v10 matching project standard
RUN corepack enable && corepack prepare pnpm@10 --activate

# Install all dependencies (including devDependencies like esbuild)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source code and build frontend bundles
COPY . .
RUN pnpm build

# =============================================================================
# Stage 2: Production runtime
# =============================================================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787

RUN corepack enable && corepack prepare pnpm@10 --activate

# Install production dependencies only
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Copy static assets and application code
COPY public ./public
COPY --from=builder /app/public/assets/charts.js ./public/assets/charts.js
COPY lib ./lib
COPY data ./data
COPY server.js ./

# Ensure data directory exists and set non-root user permissions
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/api/health || exit 1

CMD ["node", "server.js"]
