FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    python3 \
    make \
    g++ \
    sqlite3 \
    unzip \
  && rm -rf /var/lib/apt/lists/*

COPY output/package/codexapp.tgz /tmp/codexapp.tgz

# The Node image already has matching headers; do not depend on downloading them
# for node-pty's optional native build, which npm can otherwise silently omit.
RUN npm_config_nodedir=/usr/local npm install -g /tmp/codexapp.tgz \
  && node -e "if(typeof require('/usr/local/lib/node_modules/codexapp/node_modules/node-pty').spawn!=='function')process.exit(1)" \
  && npm install -g @openai/codex@0.153.4 \
  && codex --version \
  && npm cache clean --force \
  && rm /tmp/codexapp.tgz

COPY output/api-proxy-component/ /opt/codexapp-api-proxy/

ENV CODEX_HOME=/codex-home
ENV TZ=Asia/Shanghai
RUN mkdir -p /codex-home /home/Code \
  && chmod 700 /codex-home

WORKDIR /home/Code
EXPOSE 59001

CMD ["sh", "-lc", "chmod 700 /codex-home && exec codexapp --port 59001 --strict-port --no-password --no-open"]
