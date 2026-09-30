# How to Switch Vercel Servers

If you ever need to switch your active server (e.g., from Vercel 2 back to Vercel 1 after your 15 days are up), simply follow these 3 steps to completely move the system.

### 1. Update the Chrome Extension
1. Right-click the Order Alert Chrome Extension and click **Options**.
2. Change the **App URL** to the server you want to make active:
   * **Vercel 1 (Main):** `https://bot-ruby-pi.vercel.app`
   * **Vercel 2 (Backup):** `https://bot-seven-gules.vercel.app`
3. Click **Save**. *(You do not need to change the password secret).*

### 2. Move the Telegram Brain (Webhook)
You must tell Telegram which server should receive and reply to your messages. Paste the correct link below into a new Chrome tab and hit Enter. *(Replace `<YOUR_BOT_TOKEN>` with your actual Telegram bot token).*

* **Route to Vercel 1:**
  `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://bot-ruby-pi.vercel.app/api/telegram-webhook`
  
* **Route to Vercel 2:**
  `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://bot-seven-gules.vercel.app/api/telegram-webhook`

*(You should see a message saying `{"ok":true,"description":"Webhook was set"}`).*

### 3. Toggle the Cron Jobs
1. Log in to your [cron-job.org](https://cron-job.org) dashboard.
2. Check the boxes next to the 5 jobs for the **OLD** server and click **Disable** (Pause).
3. Check the boxes next to the 5 jobs for the **NEW** server and click **Enable** (Unpause).

---

### How to Verify the Switch was Successful
1. Turn your Chrome Extension **ON**.
2. Go to your Telegram bot and type `/vercel`. It should reply with the domain of the new server!
3. Type `/status`. It should show **[💻 Local Mode Active]** for both Amazon and Myntra.
4. Go to your Vercel Dashboard, open the new server, click the **Engine** page on the sidebar, and confirm everything is green!

---

### How to Deploy Code Updates (Private Repo Mode)
Because both repositories are now **Private**, you can no longer use the "Sync fork" button on GitHub. 

To update the code for **both** Vercel servers at the same time, open your computer terminal inside this folder and run:
1. `git push origin main` *(Updates Vercel 1)*
2. `git push vercel2 main` *(Updates Vercel 2)*
