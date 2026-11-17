# The sandbox daemon (daemon/, Go), the only compiled part: a static binary for the image's platform. parpaing copies it
# into the parpaing-daemon volume, and every sandbox runs it from there.
FROM --platform=$BUILDPLATFORM golang:1.27-trixie AS daemon
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY daemon/ ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /parpaingd .

# parpaing: Node runs the TypeScript as is, nothing is compiled.
FROM node:26-trixie-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY --from=daemon /parpaingd ./parpaingd
EXPOSE 8090
CMD ["node", "src/main.ts"]
