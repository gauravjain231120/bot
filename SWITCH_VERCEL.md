# Switching Vercel Servers (Automatic Zero-Maintenance Mode)

Both the **Order Alerts Bot** and **Stock Manager** are designed with full automatic failover between your two Vercel accounts:

* **Vercel 1 (Main):**
  * Bot: `https://bot-ruby-pi.vercel.app`
  * Stock Manager: `https://stock-manager-niko.vercel.app/ship`
* **Vercel 2 (Backup):**
  * Bot: `https://bot-seven-gules.vercel.app`
  * Stock Manager: `https://stock-manager-self-nine.vercel.app/ship`

---

### What is Now 100% Automated

1. **Automatic Stock Manager Failover in the Bot:**
   * Every Stock Manager operation (adding to Ready-to-Ship, removing cancelled orders, logging returns, checking RTD/holidays, Telegram `/ship` and `/make`) uses `lib/stockManagerUrl.js` with `withFailover`.
   * If the primary Stock Manager URL is paused (`503 DEPLOYMENT_PAUSED`) or unreachable, it automatically retries with the alternate Stock Manager URL and caches the working one. **No code edit needed.**

2. **Automatic Chrome Extension Failover:**
   * The browser extension (`background.js`) uses `fetchBot`. If your active server pauses and returns `503`, the extension immediately falls over to the alternate server (`bot-ruby-pi.vercel.app` ⇄ `bot-seven-gules.vercel.app`) and auto-updates its saved `appUrl`.
   * Permissions for all `*.vercel.app` domains are granted in `manifest.json`.

3. **Automatic Telegram Webhook Sync:**
   * Whenever traffic (such as cron jobs or the extension) hits whichever server is unpaused, the server checks whether Telegram's webhook is pointed to itself. If it isn't, it calls Telegram's `setWebhook` automatically and updates the database record. You do not need to manually paste webhook URLs in browser tabs anymore.

---

### Switching Accounts Every ~15 Days

When one Vercel account hits its free-tier limit and is paused:
1. In your **Vercel Dashboard**, unpause / enable the project on your other account (and pause the old one).
2. In **[cron-job.org](https://cron-job.org)**:
   * Pause the jobs for the old server.
   * Unpause the jobs for the new server.
3. Open your active Stock Manager URL in your browser:
   * Vercel 1 active: `https://stock-manager-niko.vercel.app/ship`
   * Vercel 2 active: `https://stock-manager-self-nine.vercel.app/ship`

Everything else (Extension synchronization, Stock Manager API calls, Telegram webhook routing) adjusts automatically on the first request!

---

### How to Deploy Code Updates to Both Servers
Both remotes (`origin` for Vercel 1 and `vercel2` for Vercel 2) are kept in sync:
```bash
git push origin main
git push vercel2 main
```
