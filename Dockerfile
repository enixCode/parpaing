# parpaing: Node runs the TypeScript as is, nothing is compiled.
FROM node:26-trixie-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
EXPOSE 8090
CMD ["node", "src/main.ts"]
