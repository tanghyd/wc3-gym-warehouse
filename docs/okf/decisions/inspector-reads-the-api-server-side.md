---
type: Decision
title: The inspector reads the API server-side
description: "The browser never calls the API or ClickHouse; the Next.js server does, and only the page is public."
tags: [web, api]
generated: { by: claude-code/claude-fable-5-1, at: 2026-10-02T17:50:00Z }
sources:
  - id: api
    resource: ../../../web/src/lib/api.ts
    title: The server reads
---

# Decision

Made 2026-10-01. The inspector's server functions read the API over the compose network and render the page. The browser receives HTML and calls back only through the app's own server actions.

# Why

One public surface instead of two: the API and ClickHouse are never exposed, a rate limit sits on one host, and the API's shape can change without a browser cache to wait out. Server rendering also keeps a search result a plain link.

# What it means for new code

A page reads data in `web/src/lib/api.ts` or a server action, never with `fetch` in a client component. A new read states its timeout.
