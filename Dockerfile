FROM node:22-alpine

WORKDIR /app

# Copy manifests first so the dependency layer stays cached when source changes
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY db ./db

# Do not run as root
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

# Documentation only; the real port comes from the PORT env var Render injects
EXPOSE 3000

CMD ["node", "server/index.js"]
