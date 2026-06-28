# rosterator

Public **distribution** repository for the Rosterator SPA — the rendered output that
**Vercel** hosts. This repo is generated, not authored.

- **Source of truth:** the private FootyManager repo. All code & data changes happen there.
- **How it's updated:** `make deploy-dev` / `make deploy-prod` in FootyManager render the
  built SPA into `docs/` here and push (`dev` = Vercel preview, `main` = Vercel production).
- **Do not edit `docs/` by hand** — it is overwritten on every deploy.

Hosting is **Vercel only** (see `vercel.json`: `outputDirectory: docs`, SPA rewrite to
`/index.html`). GitHub Pages is no longer used.

Live: https://rosterator.vercel.app
