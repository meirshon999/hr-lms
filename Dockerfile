# Один образ: собирает фронт и бэк, запускает один процесс на $PORT.
# Контекст сборки — корень проекта (нужен openapi.yaml для /docs).
FROM node:24-alpine AS build
WORKDIR /app
COPY prototype/package*.json ./prototype/
COPY prototype/server/package*.json ./prototype/server/
COPY prototype/web/package*.json ./prototype/web/
RUN cd prototype && npm install
COPY prototype ./prototype
COPY openapi.yaml ./openapi.yaml
RUN cd prototype && npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production TZ_LMS=Asia/Almaty PORT=3001
COPY --from=build /app /app
EXPOSE 3001
CMD ["node", "prototype/server/dist/index.js"]
