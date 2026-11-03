# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through
GitHub: **Security → Report a vulnerability** on this repository
([direct link](https://github.com/vxlhr/pingward/security/advisories/new)).

Include what you found, how to reproduce it, and the impact you expect. You'll get an answer
within a few days, and a fix is released before the details are made public.

## Supported versions

Only the latest commit on `main` (and the `ghcr.io/vxlhr/pingward:latest` image built from it)
gets security fixes.

## Scope

In scope: the Worker API, the dashboard, the Docker image, and the deployment configuration in
this repository. The design is described in the README's
[Security model](README.md#security-model).

Out of scope: the public demo's monitored services themselves, rate limiting by Cloudflare,
and reports that need a stolen `API_TOKEN` or access to the Cloudflare account.
