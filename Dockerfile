# ---- Build stage ----
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
# Persistent data (call logs, agents) — mount a Railway volume here in production.
ENV DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
