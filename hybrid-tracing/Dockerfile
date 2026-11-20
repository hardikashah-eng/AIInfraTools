# skew-corrector service.
#   docker build -t <registry>/skew-corrector:0.1 hybrid-tracing
FROM node:22-alpine
WORKDIR /app
COPY src ./src
COPY tools/skew-corrector.mjs ./tools/skew-corrector.mjs
USER node
EXPOSE 4318
ENTRYPOINT ["node", "tools/skew-corrector.mjs"]
