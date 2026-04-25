# AI Dashboard Backend — Production Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package files and install deps
COPY backend/package*.json ./
RUN npm ci --only=production

# Copy backend source
COPY backend/ ./

# Create data directory
RUN mkdir -p data

# The backend reads PORT from env (defaults to 3001)
ENV PORT=3001
ENV NODE_ENV=production

EXPOSE 3001

CMD ["node", "server.js"]
