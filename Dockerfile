# One image for the web app and both workers (the compose file picks the command). It carries the dev dependencies
# because the workers and migrations run TypeScript through tsx, and headless Chromium for the render phase.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

COPY package.json package-lock.json ./
# NODE_ENV=production would skip devDependencies (tsx, typescript, drizzle-kit).
RUN npm ci --include=dev && npx playwright install --with-deps chromium-headless-shell \
    && rm -rf /var/lib/apt/lists/* && chmod -R a+rX /ms-playwright

COPY . .
RUN npm run build && mkdir -p /data && chown -R node:node /app /data

USER node
ENV SITE_SENTRY_DATA_DIR=/data BLOB_DIR=/data/blobs
EXPOSE 3000
CMD ["npm", "start", "--", "-H", "0.0.0.0"]
