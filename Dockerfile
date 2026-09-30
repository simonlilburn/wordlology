# syntax=docker/dockerfile:1.7
#
# wordlology web app: the Rust solver built to WebAssembly, the Svelte/Vite app,
# and a small Caddy image that serves the static build with the headers the
# app needs (COOP/COEP, application/wasm, long-lived hashed assets).
#
#   docker build -t wordlology .
#   docker run --rm -p 8080:8080 wordlology      # http://localhost:8080
#
# The build stages produce platform-independent files (WASM, JS, data), so
# they run on the build platform even when the final image targets another.

# ---- 1. Solver → WebAssembly (web/src/wasm/pkg) ------------------------------
FROM --platform=$BUILDPLATFORM rust:1-bookworm AS wasm
RUN rustup target add wasm32-unknown-unknown \
 && cargo install --locked wasm-pack
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    wasm-pack build crates/wl-wasm --release --target web --out-dir /pkg --out-name wl_wasm \
 && rm -f /pkg/.gitignore

# ---- 2. Web app (web/dist) -----------------------------------------------------
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web
WORKDIR /app
COPY web/package.json web/package-lock.json ./web/
RUN --mount=type=cache,target=/root/.npm \
    cd web && npm ci --no-audit --no-fund
COPY data/wordlists ./data/wordlists
COPY precomputed ./precomputed
COPY web ./web
COPY --from=wasm /pkg ./web/src/wasm/pkg
WORKDIR /app/web
RUN node scripts/sync-data.mjs \
 && npx vite build

# ---- 3. Static server ------------------------------------------------------------
FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /app/web/dist /srv
ENV PORT=8080
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
