# KELISS invoice worker — Node + Chromium, listens on $PORT for HubSpot webhooks.
#   docker build -t keliss-invoice-worker .
#   docker run --env-file .env -p 8080:8080 keliss-invoice-worker
FROM node:22-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=8080

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/*

COPY worker.js comments.js config.js i18n.js reps.json invoice-template.html ./
# Rep photos and signatures referenced from reps.json by path.
COPY assets ./assets

USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "worker.js"]
