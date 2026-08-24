FROM node:24-bookworm-slim AS builder

WORKDIR /build
COPY apps/device-gateway/package.runtime.json ./package.json
RUN npm install --ignore-scripts \
  && npm install --no-save --ignore-scripts typescript@5.9.3 @types/node@24.10.1 @types/ws@8.18.1

COPY packages/device-gateway-client ./node_modules/@lobechat/device-gateway-client
COPY apps/device-gateway/tsconfig.json apps/device-gateway/tsconfig.build.json ./
COPY apps/device-gateway/src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY apps/device-gateway/package.runtime.json ./package.json
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /build/dist ./dist

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
