// Background Service Worker — запити до Google Sheets (без CORS обмежень)

const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbwMs_Z7yQAzniNgot_x6NYYrVLby9-KPkQafQ_sj9KKkTLdBf8GG4n0RR7b28_EDGXchw/exec';

chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
  if (msg.type === 'sheets_check') {
    sheetsCheck(msg.competitor, msg.usernames)
      .then(filtered => sendResponse({ filtered }))
      .catch(() => sendResponse({ filtered: msg.usernames }));
    return true;
  }
  if (msg.type === 'sheets_add') {
    sheetsAdd(msg.competitor, msg.username, msg.likesCount, msg.date)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'sheets_add_header') {
    sheetsAddHeader(msg.sheetTab, msg.postUrl)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

async function sheetsCheck(competitor, usernames) {
  const params = new URLSearchParams({
    action: 'check',
    competitor,
    usernames: JSON.stringify(usernames),
  });
  const res = await fetch(`${SHEETS_URL}?${params}`);
  const json = await res.json();
  return json.filtered ?? usernames;
}

async function sheetsAdd(competitor, username, likesCount, date) {
  const params = new URLSearchParams({ action: 'add', competitor, username, likesCount, date });
  await fetch(`${SHEETS_URL}?${params}`);
}

async function sheetsAddHeader(sheetTab, postUrl) {
  const params = new URLSearchParams({ action: 'add_header', competitor: sheetTab, postUrl });
  await fetch(`${SHEETS_URL}?${params}`);
}
