# OGI Marketplace

Marketplace data and automation for OpenGameInstaller addons.

The marketplace is deployed to GitHub Pages and is available at `/api/marketplace.json`.

## Maintainer commands

On addon submission and update issues:

- `/approve` adds a submitted addon or applies the requested update.
- `/ban [@user]` bans the issue creator, or the mentioned user, from addon creation/update requests.
- `/trust [@user]` trusts the issue creator, or the mentioned user, and auto-approves their valid addon update requests.
- `/bump <commit|tag|branch>` can be used by the issue creator to change the requested target ref.
