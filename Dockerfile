FROM node:20-bookworm
WORKDIR /app
COPY package*.json ./
COPY client/package*.json client/
RUN npm ci && npm ci --prefix client
COPY . .
RUN npx playwright install --with-deps chromium \
    && npx prisma generate --schema server/prisma/schema.prisma \
    && npm run build \
    && mkdir -p /app/data
EXPOSE 4000
CMD ["npm","start"]
