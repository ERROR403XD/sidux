# Local candidate build over the previously verified Node/CLI/native dependency image.
# No runtime state is copied from a running container.
FROM codexapp-verified-cli:0.153.4-4c1eee4
COPY output/package/codexapp.tgz /tmp/codexapp.tgz
# Install the actual package so removed dependencies are not inherited from the base.
RUN cp -a /usr/local/lib/node_modules/codexapp/node_modules/node-pty /tmp/verified-node-pty \
  && npm install -g --omit=dev /tmp/codexapp.tgz \
  && (test -d /usr/local/lib/node_modules/codexapp/node_modules/node-pty || cp -a /tmp/verified-node-pty /usr/local/lib/node_modules/codexapp/node_modules/node-pty) \
  && node -e "if(typeof require('/usr/local/lib/node_modules/codexapp/node_modules/node-pty').spawn!=='function')process.exit(1)" \
  && codex --version \
  && rm -rf /tmp/codexapp.tgz /tmp/verified-node-pty
COPY output/api-proxy-component/ /opt/codexapp-api-proxy/
RUN node -e "const fs=require('fs'),crypto=require('crypto');const p='/opt/codexapp-api-proxy/';const m=JSON.parse(fs.readFileSync(p+'manifest.json'));if(crypto.createHash('sha256').update(fs.readFileSync(p+'cli-proxy-api')).digest('hex')!==m.binarySha256)process.exit(1)"
