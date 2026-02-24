FROM oven/bun:debian

WORKDIR /app

# Install supercronic (cron for containers) and zstd (for decompressing .zst data files)
RUN apt-get update -qq && apt-get install -yqq curl zstd >/dev/null 2>&1 && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://github.com/aptible/supercronic/releases/download/v0.2.33/supercronic-linux-amd64 -o /usr/local/bin/supercronic \
    && chmod +x /usr/local/bin/supercronic

# Copy package files and install dependencies (Linux-native)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy source code
COPY . .
