# Build your own marketplace

This repository is a GitHub Actions template for building and operating your own OpenGameInstaller addon marketplace. Fork it, enable the included workflows, and GitHub Actions will validate addon requests, update marketplace data, and publish a static marketplace API with GitHub Pages.

Use this guide to set up your fork as an independent marketplace.

## 1. Fork the template repository

1. Click **Fork** on GitHub.
2. Keep the default branch named `main`.
3. Clone your fork locally if you want to edit it:
   ```bash
   git clone https://github.com/YOUR-USER/YOUR-FORK.git
   cd YOUR-FORK
   ```

## 2. Enable GitHub Actions

1. In your fork, open **Actions**.
2. If prompted, click **I understand my workflows, go ahead and enable them**.
3. Open **Settings → Actions → General**.
4. Under **Workflow permissions**, select **Read and write permissions**.
5. Enable **Allow GitHub Actions to create and approve pull requests** if your organization policy requires it for bot commits.
6. Click **Save**.

## 3. Enable GitHub Pages

1. Open **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Save the setting.

The `Deploy GitHub Pages` workflow publishes the marketplace JSON to:

```text
https://YOUR-USER.github.io/YOUR-FORK/api/marketplace.json
```

## 4. Enable Discussions

Addon approvals create/update GitHub Discussions.

1. Open **Settings → General**.
2. Enable **Discussions**.
3. Open the new **Discussions** tab.
4. Make sure at least one category exists. A category named `addons`, `addon`, `show-and-tell`, `announcements`, or `general` is preferred.

## 5. Confirm issue forms and labels

This template includes issue forms for addon creation and addon updates:

- `.github/ISSUE_TEMPLATE/addon-create.yml`
- `.github/ISSUE_TEMPLATE/addon-update.yml`

GitHub will create labels automatically when issues are opened, but you can also create these labels manually:

- `addon-create`
- `addon-update`

## 6. Sync generated files

After changing `marketplace.json`, run locally:

```bash
node scripts/update-addon-issue-template.mjs
node scripts/sync-pages-api.mjs
```

Then commit the updated files:

```bash
git add marketplace.json api/marketplace.json .github/ISSUE_TEMPLATE/addon-update.yml
git commit -m "chore: update marketplace"
git push
```

The `Sync generated marketplace files` workflow can also update generated files automatically after marketplace changes are pushed.

## 7. Maintainer commands

On addon submission or update issues, maintainers with write access can comment:

- `/approve` — applies the addon creation/update request.
- `/deny [reason]` — denies and closes the request.
- `/ban [@user]` — bans a user from addon requests.
- `/trust [@user]` — trusts a user and auto-approves their valid update requests.
- `/bump <commit|tag|branch>` — lets the issue creator change the requested target ref.

## 8. Required secrets

No custom secrets are required. The workflows use GitHub's built-in `GITHUB_TOKEN`.

If a workflow cannot push commits, re-check **Settings → Actions → General → Workflow permissions** and ensure read/write permissions are enabled.
