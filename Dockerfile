FROM oven/bun:debian

WORKDIR /app

# Install zstd for data decompression during imports
RUN apt-get update -qq && apt-get install -yqq zstd >/dev/null 2>&1 && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies (Linux-native)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy source code
COPY . .
