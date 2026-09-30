const fs = require('fs');
let content = fs.readFileSync('lib/DashboardContext.js', 'utf8');

const target = `const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      tick();
    }, REFRESH_MS);`;

const replacement = `// Idle tracking: if no mouse/keyboard activity for 15 minutes, stop polling Vercel
    let lastActivity = Date.now();
    const updateActivity = () => { lastActivity = Date.now(); };
    window.addEventListener('mousemove', updateActivity);
    window.addEventListener('keydown', updateActivity);
    window.addEventListener('click', updateActivity);
    window.addEventListener('scroll', updateActivity);

    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (Date.now() - lastActivity > 15 * 60 * 1000) return; // Paused (user is AFK)
      tick();
    }, REFRESH_MS);`;

const cleanupTarget = `document.removeEventListener('visibilitychange', onVisible);
    };`;

const cleanupReplacement = `document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('mousemove', updateActivity);
      window.removeEventListener('keydown', updateActivity);
      window.removeEventListener('click', updateActivity);
      window.removeEventListener('scroll', updateActivity);
    };`;

content = content.replace(target, replacement);
content = content.replace(cleanupTarget, cleanupReplacement);

fs.writeFileSync('lib/DashboardContext.js', content);
