FROM node:20-alpine

WORKDIR /app

COPY server/package.json ./
RUN npm install --production

COPY server/ ./

# Copy frontend for standalone browser preview
COPY public/ ./public/

EXPOSE 3777

CMD ["node", "index.js"]
