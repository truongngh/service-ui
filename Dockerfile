# Multi-stage build: install deps in a build stage, copy only what the
# runtime needs into a slim Alpine image.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev            # requires a committed package-lock.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8081
COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY public ./public
EXPOSE 8081
USER node
CMD ["node", "src/server.js"]
