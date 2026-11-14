FROM oven/bun:1.4.4-slim
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bunx prisma generate --config prisma/prisma.config.ts

ENV NODE_ENV=production
USER bun
CMD ["bun", "index.ts"]
