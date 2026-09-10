FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.mjs nas-fetch-proxy-lib.mjs ./

EXPOSE 8088

CMD ["node", "index.mjs"]
