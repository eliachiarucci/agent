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

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY system-prompt.txt ./

EXPOSE 3001

CMD ["node", "dist/index.js"]
