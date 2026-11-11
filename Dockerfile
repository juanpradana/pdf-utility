# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — install production dependencies
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps

WORKDIR /app

# Copy manifests first so this layer is cached until dependencies change.
COPY package.json package-lock.json ./

# npm ci installs exactly what the lockfile pins.  --omit=dev keeps nodemon out.
RUN npm ci --omit=dev && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 2 — runtime image
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# tini reaps zombie processes and forwards SIGTERM so `docker stop` is clean.
RUN apk add --no-cache tini \
 && addgroup -g 1001 -S pdfapp \
 && adduser  -u 1001 -S pdfapp -G pdfapp

WORKDIR /app

# Application code and dependencies.
COPY --from=deps --chown=pdfapp:pdfapp /app/node_modules ./node_modules
COPY --chown=pdfapp:pdfapp package.json package-lock.json server.js ./
COPY --chown=pdfapp:pdfapp public ./public

# Temp storage lives on a volume-mounted path, owned by the unprivileged user.
RUN mkdir -p /data/uploads /data/outputs \
 && chown -R pdfapp:pdfapp /data

USER pdfapp

ENV NODE_ENV=production \
    PORT=3001 \
    UPLOAD_DIR=/data/uploads \
    OUTPUT_DIR=/data/outputs \
    TRUST_PROXY=true

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]