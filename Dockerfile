# Один образ: собирает фронт и бэк, запускает один процесс на $PORT.
# Контекст сборки — корень проекта (нужен openapi.yaml для /docs).
FROM node:24-alpine AS build
WORKDIR /srv
COPY app/package*.json ./app/
COPY app/server/package*.json ./app/server/
COPY app/web/package*.json ./app/web/
RUN cd app && npm install
COPY app ./app
COPY openapi.yaml ./openapi.yaml
RUN cd app && npm run build

FROM node:24-alpine
WORKDIR /srv
ENV NODE_ENV=production TZ_LMS=Asia/Almaty PORT=3001
COPY --from=build /srv /srv
EXPOSE 3001
CMD ["node", "app/server/dist/index.js"]
