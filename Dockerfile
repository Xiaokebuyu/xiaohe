FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

RUN apt-get purge -y python3 make g++ && apt-get autoremove -y

COPY src/ ./src/

RUN mkdir -p src/memory logs

ENV NODE_ENV=production
ENV PORT=3100
EXPOSE 3100

CMD ["node", "src/server.js"]
