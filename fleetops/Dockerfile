# fleetops service (ingest + read API) with the Parquet backend.
#   docker build -f fleetops/Dockerfile -t <registry>/fleetops:0.1 .      (from the repository root: fleetops reads
#   gpu-health, fleetscope and inference-sizer sources)
FROM node:22-slim
WORKDIR /app
COPY gpu-health/src ./gpu-health/src
COPY fleetscope/src ./fleetscope/src
COPY inference-sizer/src ./inference-sizer/src
COPY fleetops/package.json ./fleetops/
COPY fleetops/src ./fleetops/src
COPY fleetops/tools ./fleetops/tools
WORKDIR /app/fleetops
RUN npm install --no-save --no-package-lock --no-audit --no-fund @duckdb/node-api@2.0.1-r.1 && npm cache clean --force
RUN mkdir -p /data && chown node:node /data   # a named volume mounted here starts owned by the service user
USER node
EXPOSE 9400
ENTRYPOINT ["node", "tools/fleetops.mjs"]
CMD ["serve", "--host", "0.0.0.0", "--port", "9400", "--store", "/data", "--backend", "parquet", "--tokens", "/etc/fleetops/tokens.jsonl"]
