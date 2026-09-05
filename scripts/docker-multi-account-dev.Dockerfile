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

RUN npm install -g /tmp/codexapp.tgz @openai/codex@0.153.4 \
  && npm cache clean --force \
  && rm /tmp/codexapp.tgz

ENV CODEX_HOME=/codex-home
ENV TZ=Asia/Shanghai
RUN mkdir -p /codex-home /home/Code \
  && chmod 700 /codex-home

WORKDIR /home/Code
EXPOSE 59001

CMD ["sh", "-lc", "chmod 700 /codex-home && exec codexapp --port 59001 --strict-port --no-password --no-open"]
