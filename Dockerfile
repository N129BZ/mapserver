# --- Build Stage ---
FROM node:24-alpine AS builder
WORKDIR /mapserver

# Install build dependencies for native addon compilation (better-sqlite3)
RUN apk add --no-cache python3 make g++ 

COPY package*.json ./
RUN npm install
COPY client/package*.json ./client/
RUN npm --prefix client install
COPY . .
RUN npm run build-client

# --- Production Stage ---
FROM node:24-alpine
WORKDIR /mapserver
ENV NODE_ENV=production

# Install native dependencies if required at production runtime
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install --only=production

# Aligned paths: copy from /mapserver instead of /app
COPY --from=builder /mapserver/client/dist ./client/dist
COPY --from=builder /mapserver/server.js ./
COPY --from=builder /mapserver/settings.json ./
COPY --from=builder /mapserver/airports.db ./
COPY --from=builder /mapserver/tiles ./tiles
EXPOSE 8600
CMD ["node", "server.js"]