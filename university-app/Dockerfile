# syntax=docker/dockerfile:1
#
# Build context must be the repository root:
#   docker build -f university-app/Dockerfile -t university-app .
#
# The university-app depends on es-dcb-library via "file:../" — the library
# is built in the first stage and shared with subsequent stages.

# ──────────────────────────────────────────────────────────────────────────────
# Stage 1: build the es-dcb-library (produces dist/)
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS library-builder
WORKDIR /repo

# Install library deps
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Build the library
COPY tsconfig.json tsconfig.build.json tsup.config.ts ./
COPY src/ ./src/
RUN npm run build

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: install university-app production dependencies
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS app-deps
WORKDIR /repo

# Restore library so the file:../ reference in university-app resolves correctly
COPY --from=library-builder /repo/package.json /repo/dist/ ./dist/
COPY --from=library-builder /repo/package.json ./

# Install university-app deps (file:../ resolves to /repo)
COPY university-app/package.json university-app/package-lock.json ./university-app/
RUN cd university-app && npm ci --omit=dev --ignore-scripts

# ──────────────────────────────────────────────────────────────────────────────
# Stage 3: compile university-app TypeScript
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS app-builder
WORKDIR /repo

# Need the library and all deps (including devDeps for tsc)
COPY --from=library-builder /repo/package.json /repo/dist/ ./dist/
COPY --from=library-builder /repo/package.json ./

COPY university-app/package.json university-app/package-lock.json ./university-app/
RUN cd university-app && npm ci --ignore-scripts

COPY university-app/src/ ./university-app/src/
COPY university-app/tsconfig.json university-app/tsconfig.build.json ./university-app/
RUN cd university-app && npm run build

# ──────────────────────────────────────────────────────────────────────────────
# Stage 4: production image (minimal)
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /repo

ENV NODE_ENV=production

# Library runtime files
COPY --from=library-builder /repo/package.json ./
COPY --from=library-builder /repo/dist/ ./dist/

# University-app production node_modules + compiled output
COPY --from=app-deps     /repo/university-app/node_modules/ ./university-app/node_modules/
COPY --from=app-builder  /repo/university-app/dist/         ./university-app/dist/
COPY --from=app-builder  /repo/university-app/package.json  ./university-app/

WORKDIR /repo/university-app

ENV PORT=3000
EXPOSE 3000

# Run as non-root
USER node

CMD ["node", "dist/src/index.js"]
