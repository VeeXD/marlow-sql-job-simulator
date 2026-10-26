FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 1001 marlow

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/engine/package.json packages/engine/package.json

RUN npm ci

COPY . .
RUN npm run build -w @sim/web \
  && chown -R marlow:marlow /app

ENV NODE_ENV=production
ENV ALLOW_SIGNALS_PAGE=false
ENV ALLOW_DEBUG_CLOCK=false
ENV LLM_PROVIDER=mock
ENV PORT=3847
ENV WEB_PORT=3847
ENV WEB_INTERNAL_PORT=3846
ENV API_PORT=3848

EXPOSE 3847

USER marlow

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "const p=process.env.PORT||process.env.WEB_PORT||3847; fetch('http://127.0.0.1:'+p+'/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Boot also migrates and builds marlow_template. `npm run release` does the same
# as a platform release command before traffic shifts.
CMD ["npm", "run", "start"]
