FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/engine/package.json packages/engine/package.json

RUN npm ci

COPY . .

RUN npm run build -w @sim/web

ENV NODE_ENV=production
ENV WEB_PORT=3847
ENV WEB_INTERNAL_PORT=3846
ENV API_PORT=3848
EXPOSE 3847

CMD ["npm", "run", "start"]
