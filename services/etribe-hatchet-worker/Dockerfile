FROM node:22.18.0-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY worker.ts ./worker.ts

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
