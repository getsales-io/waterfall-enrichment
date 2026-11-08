# The waterfall-enrichment CLI in a container: the build stage compiles and
# runs the offline tests, the runtime stage carries only the compiled files
# (the CLI has no runtime dependencies).
#
#   docker build -t waterfall-enrichment .
#   docker run --rm -it -e GETSALES_API_KEY -v "$PWD:/data" waterfall-enrichment people.csv

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.test.json README.md ./
COPY src ./src
COPY test ./test
COPY examples ./examples
RUN npm run build && npm test

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/dist ./dist
COPY LICENSE ./LICENSE
WORKDIR /data
USER node
ENTRYPOINT ["node", "/app/dist/bin.js"]
CMD ["--help"]
