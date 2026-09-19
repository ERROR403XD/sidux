# Contributor guidance

- Keep Chinese and English READMEs aligned. Preserve upstream attribution and third-party licenses.
- Never commit credentials, personal conversations, local environment files, browser traces, or private screenshots.
- Keep changes focused. Build and run relevant tests before submitting a pull request.
- Use shared AppDialog, AppPopover, AppSelect and AppButton controls for UI changes; check light and dark themes.
- Audit performance for behavior changes. Avoid duplicate requests, blocking work and unbounded fanout.
- Document reproducible manual checks in tests.md. Use synthetic data and isolated CODEX_HOME directories.
