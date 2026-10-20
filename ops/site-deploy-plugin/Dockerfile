# C293a: the website deploy plugin (Woodpecker plugin image). Built and pushed by ops/site-deploy-plugin-publish.ts, never by hand.
# Base pinned by digest (C59); bump the digest deliberately. git + openssh-client: the plugin pushes site-dev/site-live over SSH.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
RUN apk add --no-cache git openssh-client \
 && adduser -D -u 10001 deploy
WORKDIR /app
COPY site-deploy.ts VERSION ./
USER deploy
# Woodpecker runs a plugin in the pipeline workspace; settings arrive as PLUGIN_* environment variables.
ENTRYPOINT ["node", "/app/site-deploy.ts"]
