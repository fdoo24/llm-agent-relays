FROM node:20-alpine

WORKDIR /app

# Create required directories for logs and state
RUN mkdir -p /app/logs /app/data /app/relays /app/src

COPY package.json ./
COPY index.js ./
COPY relays/ ./relays/
COPY src/ ./src/
COPY scripts/ ./scripts/

# Default to listening on all container interfaces
ENV RELAY_LISTEN_HOST=0.0.0.0
# By default in docker compose, reach the host machine's proxy
ENV RELAY_PROXY_HOST=host.docker.internal
ENV RELAY_PROXY_PORTS=12334,10808

EXPOSE 8818 8819 8820

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8820/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "index.js"]
