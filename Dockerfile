# --- Build Stage ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY client/package*.json ./client/
RUN npm --prefix client install
COPY . .
RUN npm run build-client

# --- Production Stage ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --only=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.js ./
COPY --from=builder /app/appsettings.json ./
# Expose your active port
EXPOSE 8600
CMD ["node", "server.js"]
