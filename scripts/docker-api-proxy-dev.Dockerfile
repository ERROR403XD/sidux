# Local candidate build over the previously verified Node/CLI/native dependency image.
# No runtime state is copied from a running container.
FROM codexapp-verified-cli:0.153.4-4c1eee4
COPY output/package/codexapp.tgz /tmp/codexapp.tgz
RUN mkdir /tmp/codexapp-packed \
  && tar -xzf /tmp/codexapp.tgz --strip-components=1 -C /tmp/codexapp-packed \
  && node -e "const a=require('/tmp/codexapp-packed/package.json'),b=require('/usr/local/lib/node_modules/codexapp/package.json');delete a.version;delete b.version;if(JSON.stringify(a)!==JSON.stringify(b))throw Error('Packed dependency metadata differs from the verified base')" \
  && rm -rf /usr/local/lib/node_modules/codexapp/dist /usr/local/lib/node_modules/codexapp/dist-cli \
  && cp -a /tmp/codexapp-packed/. /usr/local/lib/node_modules/codexapp/ \
  && node -e "if(typeof require('/usr/local/lib/node_modules/codexapp/node_modules/node-pty').spawn!=='function')process.exit(1)" \
  && codex --version \
  && rm -rf /tmp/codexapp.tgz /tmp/codexapp-packed
COPY output/api-proxy-component/ /opt/codexapp-api-proxy/
RUN node -e "const fs=require('fs'),crypto=require('crypto');const p='/opt/codexapp-api-proxy/';const m=JSON.parse(fs.readFileSync(p+'manifest.json'));if(crypto.createHash('sha256').update(fs.readFileSync(p+'cli-proxy-api')).digest('hex')!==m.binarySha256)process.exit(1)"
