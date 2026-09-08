FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

ENV HOST=0.0.0.0
ENV PORT=3838
EXPOSE 3838

CMD ["node", "server.js"]
