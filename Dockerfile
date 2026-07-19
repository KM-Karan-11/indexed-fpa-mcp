FROM node:20-slim

WORKDIR /app

# Install deps first for layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
# Railway/Render/Fly inject PORT; default 3000 for local docker runs
EXPOSE 3000

CMD ["node", "index.js"]
