# opt2 Portal DB backup + restore test (Railway cron service in project "opt2").
# Postgres 18 client tools (match the server) + the Node 24 binary for the TypeScript job.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS node
FROM postgres:18-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /job
COPY ops/db-backup/backup.ts /job/backup.ts
# Railway volumes are root-owned; the job only talks to Postgres over the network.
ENTRYPOINT ["node", "/job/backup.ts"]
