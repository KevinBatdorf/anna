FROM oven/bun:debian

WORKDIR /app

# Copy package files and install dependencies (Linux-native)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy source code
COPY . .
