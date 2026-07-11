# Ludo Arena game server (Fly.io). Runs the TS server via tsx — no build step.
# Build context is the REPO ROOT: `docker build -f apps/server/Dockerfile .`
FROM node:22-slim

WORKDIR /app

# Only the workspaces the server needs are copied (see .dockerignore); this keeps
# the image lean (no web/contracts toolchains) and lets npm resolve the
# game-engine/shared workspace packages that the server imports as source.
COPY package.json package-lock.json ./
COPY packages/game-engine ./packages/game-engine
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server

# Non-ci install: the lockfile covers workspaces excluded from this image, so use
# a lenient install. tsx (a devDependency) is required to run the TS entrypoint.
RUN npm install --no-audit --no-fund

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# In-memory fallback if REDIS_URL/DATABASE_URL are unset; set them as Fly secrets.
CMD ["npm", "run", "start", "-w", "apps/server"]
