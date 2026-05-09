# 3API Relay Panel — production image
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm config set registry https://registry.npmmirror.com && npm ci --omit=dev

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm config set registry https://registry.npmmirror.com && npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# UI build — Next.js static export → /app/ui/out
FROM node:20-alpine AS ui
WORKDIR /app/ui
COPY ui/package.json ui/package-lock.json* ./
RUN npm config set registry https://registry.npmmirror.com && npm install --no-audit --no-fund
COPY ui/ ./
RUN npx next build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=ui    /app/ui/out ./public
COPY db/ ./db/
COPY package.json ./

# Non-root user
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q --spider "http://localhost:${PORT:-8080}/health" || exit 1

CMD ["node", "dist/index.js"]