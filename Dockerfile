# OpenAuto CRM — obraz produkcyjny (Railway buduje go automatycznie z tego pliku)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
# pg_dump / pg_restore — do zaszyfrowanych kopii zapasowych na Google Drive
RUN apk add --no-cache postgresql-client
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY db ./db
COPY package.json ./
USER node
EXPOSE 3000
# start.js: migracje bazy → (pierwszy właściciel) → serwer
CMD ["node", "dist/server/start.js"]
