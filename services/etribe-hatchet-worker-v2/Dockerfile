FROM oven/bun:1.2.22
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY index.ts ./index.ts
EXPOSE 3000
CMD ["bun", "run", "index.ts"]
