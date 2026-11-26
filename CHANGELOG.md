# Changelog

## 2026-11-26

- Connectors: every platform recipe wired to its official API docs — credential-derived base URLs
  (Zendesk, Freshdesk, ServiceNow, Shopify, Mailchimp, Datadog, Xero, Salesforce), official Basic-auth
  formats, required version/tenant headers (GitHub 2022-11-28, Notion 2026-03-11, Intercom 2.18,
  Xero `xero-tenant-id`, Shopify Admin 2026-10), Stripe form-encoded bodies, Slack `ok:false` handling,
  429 `Retry-After` surfaced, and documented error bodies parsed into tool messages.
- Fixed: Salesforce actions previously targeted `login.salesforce.com` and could never succeed; they
  now call the org's instance URL.
- Connector SDK: auth receives `{token, account}`; Account field documents subdomain / tenant /
  app-key / shop / datacenter per platform (see README table).
