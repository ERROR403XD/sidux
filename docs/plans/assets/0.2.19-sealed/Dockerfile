FROM codexapp-resume-test:0.2.18
COPY codexapp-0.2.19.tgz /tmp/app.tgz
RUN npm install -g /tmp/app.tgz @openai/codex@0.153.4
ENV CODEX_HOME=/codex-home
CMD ["codexapp","--port","4190","--strict-port","--no-password","--no-open"]
