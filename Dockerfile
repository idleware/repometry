FROM node:24-bookworm-slim AS build
WORKDIR /repometry
COPY package.json package-lock.json tsconfig.json tsconfig.browser.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src/main ./src/main
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /repometry
COPY --from=build /repometry/package.json ./
COPY --from=build /repometry/node_modules ./node_modules
COPY --from=build /repometry/target/main ./target/main
USER node
EXPOSE 7331
ENTRYPOINT ["node", "target/main/ts/cli/main.js"]
CMD ["worker", "--listen", "0.0.0.0", "--port", "7331"]
