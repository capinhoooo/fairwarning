FROM oven/bun:1.4.4-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# Vite inlines these at build time
ARG VITE_API_URL
ARG VITE_NEAR_NETWORK
ARG VITE_FW_CONTRACT_ID
ARG VITE_USDC_CONTRACT_ID
ARG VITE_ANNOUNCER_ADDRESS
ARG VITE_GITHUB_URL
RUN bun run build

FROM node:24.9.0-slim
WORKDIR /app
COPY --from=build /app/.output ./.output
ENV NODE_ENV=production
USER node
# nitro reads PORT, which Railway sets
CMD ["node", ".output/server/index.mjs"]
