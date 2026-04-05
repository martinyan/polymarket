FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm install

COPY src ./src
RUN npm run build

CMD ["npm", "start"]
