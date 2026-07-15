---
"miniflare": patch
---

Fix local email preview dropping the message body when a sender supplies an empty `html` string

When a Worker sent an email via `send_email` with `html: ""` — as many senders and parsers produce for text-only messages — the empty string shadowed the plain-text body, so the stored `.eml` had an empty `text/html` part and the local explorer preview showed no content. Bodies are now rendered as `multipart/alternative` when both text and HTML are present, and empty/whitespace-only parts are treated as absent, preserving whichever body content actually exists.
