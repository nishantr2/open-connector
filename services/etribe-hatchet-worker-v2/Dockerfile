FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY worker.mjs ./worker.mjs
EXPOSE 3000
CMD ["node", "worker.mjs"]
