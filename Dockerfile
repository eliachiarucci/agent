# Build stage runs on the build host's native arch ($BUILDPLATFORM): esbuild
# output is plain JS, so only the runtime stage below needs the target arch.
FROM --platform=$BUILDPLATFORM node:22-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx tsx build.ts

# Runtime must be glibc-based: onnxruntime-node (in-process embeddings) ships
# no musl binaries, so alpine won't work.
FROM node:22-slim

# pg_dump backs GET /agent/backup. Its major version must be >= the database
# server's — keep the -18 in lockstep with the pgvector/pgvector:pg18 image
# (docker-compose.yml here and agent-cli's compose template).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-18 \
    && apt-get purge -y --auto-remove curl gnupg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY system-prompt.txt ./

EXPOSE 3001

CMD ["node", "dist/index.js"]
