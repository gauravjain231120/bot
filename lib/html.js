// Every Telegram message is sent with parse_mode HTML, so anything that came
// from outside (product names, SKUs, colours, categories, error text, a
// user's command text) must be escaped before it goes inside one — a single
// raw "&" or "<" (e.g. "Kurta & Palazzo") makes Telegram reject the WHOLE
// message ("can't parse entities"), i.e. the order alert never arrives.
// Only &, < and > need escaping in Telegram's HTML mode.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// The same message as plain text — the last-resort fallback when Telegram
// still refuses a message's HTML: tags dropped, entities turned back into
// characters, so the alert is delivered (unformatted) instead of not at all.
function stripHtml(text) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

module.exports = { escapeHtml, stripHtml };
