FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY system-prompt.txt ./

CMD ["node", "dist/index.js"]
