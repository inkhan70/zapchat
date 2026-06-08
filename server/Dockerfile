FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
COPY ../client/public ./public
EXPOSE 5000
CMD ["node", "index.js"]
