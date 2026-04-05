# MCP Services Container
# Hosts CLI-backed MCP tools on nanoclaw-net.
# Agent containers connect via StreamableHTTP — credentials stay here.

FROM node:22-slim

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# Build TypeScript
RUN npm run build

# Non-root user
RUN chown -R node:node /app
USER node

EXPOSE 3100

CMD ["node", "dist/index.js"]
