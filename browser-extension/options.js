const appUrlInput = document.getElementById('appUrl');
const syncSecretInput = document.getElementById('syncSecret');
const status = document.getElementById('status');

chrome.storage.local.get(['appUrl', 'syncSecret'], (v) => {
  if (v.appUrl) appUrlInput.value = v.appUrl;
  if (v.syncSecret) syncSecretInput.value = v.syncSecret;
});

document.getElementById('save').addEventListener('click', async () => {
  const appUrl = appUrlInput.value.trim().replace(/\/+$/, '');
  const syncSecret = syncSecretInput.value.trim();
  if (!appUrl || !syncSecret) {
    status.textContent = 'Fill in both fields.';
    return;
  }

  let origin;
  try {
    origin = new URL(appUrl).origin + '/*';
  } catch {
    status.textContent = 'That doesn\'t look like a valid URL.';
    return;
  }

  // Cross-origin fetches from the background script need this host explicitly
  // granted — asked for here, once, rather than at install time, since the
  // app's own URL isn't known until you type it in.
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    status.textContent = 'Permission for that URL was not granted — sync will not work without it.';
    return;
  }

  await chrome.storage.local.set({ appUrl, syncSecret });
  status.textContent = 'Saved ✓';
});
