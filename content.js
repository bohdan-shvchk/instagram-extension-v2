// Instagram Helper v2 — Content Script

const S = 'igh2_state';
const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbwMs_Z7yQAzniNgot_x6NYYrVLby9-KPkQafQ_sj9KKkTLdBf8GG4n0RR7b28_EDGXchw/exec';
const SYSTEM_USERNAMES = ['explore', 'reels', 'stories', 'direct', 'accounts', 'about', 'legal', 'p', 'tv'];

// ─── State helpers ─────────────────────────────────────────────────────────────
async function getState() {
  return new Promise(r => chrome.storage.local.get(S, d => r(d[S] || {})));
}
async function patchState(updates) {
  return new Promise(r => {
    chrome.storage.local.get(S, d => {
      chrome.storage.local.set({ [S]: { ...(d[S] || {}), ...updates } }, r);
    });
  });
}

// ─── Messages від popup ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
  if (msg.type === 'start') {
    const { settings } = msg;
    const isPost  = settings.source === 'post';
    const phase   = isPost ? 'collect_post' : 'collect';
    const destUrl = isPost ? settings.postUrl : `https://www.instagram.com/${settings.competitor}/`;
    chrome.storage.local.set({
      [S]: { running: true, phase, settings, followerQueue: [], currentFollower: null, postQueue: [], stats: { likes: 0, profiles: 0 } }
    }, () => navigate(destUrl));
    sendResponse({ ok: true });
  }
  if (msg.type === 'stop') {
    patchState({ running: false }).then(() => sendStatus('Зупинено'));
    sendResponse({ ok: true });
  }
  return true;
});

// ─── Головний runner ───────────────────────────────────────────────────────────
(async () => {
  await sleep(2000);
  const st = await getState();
  if (!st.running) return;

  if      (st.phase === 'collect')      await runCollect(st);
  else if (st.phase === 'collect_post') await runCollectPost(st);
  else if (st.phase === 'profile')      await runProfile(st);
  else if (st.phase === 'post')         await runPost(st);
})();

// ─── PHASE: collect (підписники конкурента) ───────────────────────────────────
async function runCollect(st) {
  const competitor = st.settings.competitor;

  if (!window.location.pathname.startsWith(`/${competitor}/`)) {
    navigate(`https://www.instagram.com/${competitor}/`);
    return;
  }

  sendStatus(`Відкриваю підписників @${competitor}...`);

  const followersBtn = await waitFor(() =>
    document.querySelector(`a[href="/${competitor}/followers/"]`) ||
    document.querySelector('a[href*="/followers/"]')
  );

  if (!followersBtn) {
    sendStatus('Не знайдено кнопку підписників.');
    await patchState({ running: false });
    return;
  }

  followersBtn.click();
  await sleep(2000);

  const modal = await waitFor(() => document.querySelector('[role="dialog"]'), 6000);
  if (!modal) {
    sendStatus('Модалка не відкрилась.');
    await patchState({ running: false });
    return;
  }

  sendStatus('Збираю підписників...');
  const maxCount   = st.settings.maxFollowers || 50;
  const ownUsername = getOwnUsername();
  const followers  = await collectFollowersWithObserver(modal, maxCount, ownUsername);

  if (followers.length === 0) {
    sendStatus('Не вдалось зібрати підписників.');
    await patchState({ running: false });
    return;
  }

  sendStatus(`Перевіряю ${followers.length} підписників в базі...`);
  const filtered = await sheetsCheck(competitor, followers);

  if (filtered.length === 0) {
    sendStatus('Всі підписники вже оброблені. Нових немає.');
    await patchState({ running: false });
    return;
  }

  sendStatus(`Нових підписників для обробки: ${filtered.length}`);
  await patchState({ phase: 'profile', followerQueue: filtered, currentFollower: null });

  pressEscape();
  await sleep(500);
  await goToNextFollower(await getState());
}

// ─── Збір підписників через MutationObserver ───────────────────────────────────
function collectFollowersWithObserver(modal, maxCount, ownUsername) {
  return new Promise(resolve => {
    const followers = new Set();

    const scrollable = modal.querySelector('ul') ||
                       modal.querySelector('[style*="overflow"]') ||
                       modal;

    function collectVisible() {
      const links = modal.querySelectorAll('a[href^="/"]');
      for (const link of links) {
        const href  = link.getAttribute('href') || '';
        const match = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
        if (!match) continue;
        const username = match[1];
        if (SYSTEM_USERNAMES.includes(username)) continue;
        if (ownUsername && username === ownUsername) continue;
        followers.add(username);
      }
    }

    collectVisible();

    const observer = new MutationObserver(async () => {
      collectVisible();

      if (followers.size >= maxCount) {
        observer.disconnect();
        resolve([...followers].slice(0, maxCount));
        return;
      }

      await sleep(randomBetween(1000, 4000));

      const lastItem = scrollable.querySelector('li:last-child') || scrollable.lastElementChild;
      if (lastItem) lastItem.scrollIntoView({ behavior: 'smooth', block: 'end' });
      else scrollable.scrollTop += 500;
    });

    observer.observe(modal, { childList: true, subtree: true });

    sleep(800).then(() => {
      const lastItem = scrollable.querySelector('li:last-child') || scrollable.lastElementChild;
      if (lastItem) lastItem.scrollIntoView({ behavior: 'smooth', block: 'end' });
      else scrollable.scrollTop += 500;
    });

    setTimeout(() => {
      observer.disconnect();
      resolve([...followers].slice(0, maxCount));
    }, 60000);
  });
}

// ─── PHASE: collect_post (лайкери або коментатори поста) ──────────────────────
async function runCollectPost(st) {
  const { postUrl, postSource, maxFollowers } = st.settings;

  const shortcodeMatch = postUrl.match(/\/p\/([^/?]+)/);
  if (!shortcodeMatch) {
    sendStatus('Не вдалось розпізнати посилання на пост.');
    await patchState({ running: false });
    return;
  }

  const shortcode = shortcodeMatch[1];
  const mediaId   = shortcodeToMediaId(shortcode);

  // Чекаємо завантаження поста
  await waitFor(() => document.querySelector('article'), 8000);

  sendStatus('Отримую автора поста...');
  const postAuthor = getAuthorFromDom();
  if (!postAuthor) {
    sendStatus('Не вдалось отримати автора поста.');
    await patchState({ running: false });
    return;
  }

  // Перший рядок вкладки = посилання на пост
  await sheetsAddHeader(postAuthor, postUrl);

  const ownUsername = getOwnUsername();
  let users = [];

  if (postSource === 'likers') {
    sendStatus('Збираю лайкерів поста...');
    users = await collectPostLikers(shortcode, mediaId, ownUsername);
  } else {
    sendStatus('Збираю коментаторів поста...');
    users = await collectPostCommenters(mediaId, maxFollowers || 50, ownUsername);
  }

  if (users.length === 0) {
    sendStatus('Не вдалось зібрати користувачів поста.');
    await patchState({ running: false });
    return;
  }

  sendStatus(`Перевіряю ${users.length} користувачів в базі...`);
  const filtered = await sheetsCheck(postAuthor, users);

  if (filtered.length === 0) {
    sendStatus('Всі користувачі вже оброблені. Нових немає.');
    await patchState({ running: false });
    return;
  }

  // Використовуємо postAuthor як competitor — решта фаз працюють без змін
  const newSettings = { ...st.settings, competitor: postAuthor };
  sendStatus(`Нових для обробки: ${filtered.length}`);
  await patchState({ phase: 'profile', followerQueue: filtered, currentFollower: null, settings: newSettings });
  await goToNextFollower(await getState());
}

async function collectPostLikers(shortcode, mediaId, ownUsername) {
  // Спочатку — приватний API
  try {
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1];
    const res  = await fetch(`https://www.instagram.com/api/v1/media/${mediaId}/likers/`, {
      credentials: 'include',
      headers: {
        'X-CSRFToken': csrf || '',
        'X-Instagram-AJAX': '1',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    if (res.ok) {
      const json  = await res.json();
      const users = (json.users || []).map(u => u.username).filter(u => u && u !== ownUsername);
      if (users.length > 0) return users;
    }
  } catch (e) {
    console.warn('[IGH2] likers API error:', e);
  }

  // Fallback — GraphQL
  try {
    const vars = JSON.stringify({ shortcode, include_reel: false });
    const res  = await fetch(
      `https://www.instagram.com/graphql/query/?query_hash=d5d763b1e2acf209d62d22d184488e57&variables=${encodeURIComponent(vars)}`,
      { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } }
    );
    if (!res.ok) return [];
    const json  = await res.json();
    const edges = json.data?.shortcode_media?.edge_liked_by?.edges || [];
    return edges.map(e => e.node?.username).filter(u => u && u !== ownUsername);
  } catch (e) {
    console.warn('[IGH2] likers GraphQL error:', e);
    return [];
  }
}

async function collectPostCommenters(mediaId, maxCount, ownUsername) {
  const userSet = new Set();
  let minId = null;

  while (userSet.size < maxCount) {
    const params = new URLSearchParams({ can_support_threading: 'true' });
    if (minId) params.set('min_id', minId);
    try {
      const res = await fetch(
        `https://www.instagram.com/api/v1/media/${mediaId}/comments/?${params}`,
        { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } }
      );
      if (!res.ok) break;
      const json = await res.json();
      for (const c of (json.comments || [])) {
        const u = c.user?.username;
        if (u && u !== ownUsername) userSet.add(u);
      }
      if (!json.next_min_id) break;
      minId = json.next_min_id;
      await sleep(randomBetween(500, 1500));
    } catch (e) {
      console.warn('[IGH2] commenters error:', e);
      break;
    }
  }

  return [...userSet].slice(0, maxCount);
}

// ─── PHASE: profile ────────────────────────────────────────────────────────────
async function runProfile(st) {
  const follower = st.currentFollower;
  if (!follower) { await goToNextFollower(st); return; }

  if (!window.location.pathname.startsWith(`/${follower}/`)) {
    navigate(`https://www.instagram.com/${follower}/`);
    return;
  }

  await waitFor(() => document.querySelector('main'), 8000);

  if (isPrivateProfile()) {
    sendStatus(`@${follower} — приватний, пропускаю`);
    await sheetsAdd(st.settings.competitor, follower, 'Private profile');
    await goToNextFollower(st);
    return;
  }

  await waitFor(() => document.querySelector('a[href*="/p/"]'), 5000);

  const postLinks = [...new Set(
    [...document.querySelectorAll('a[href*="/p/"]')]
      .map(a => a.getAttribute('href'))
      .filter(h => h && h.includes('/p/'))
  )].slice(0, 9);

  if (postLinks.length === 0) {
    sendStatus(`@${follower} — постів немає, пропускаю`);
    await goToNextFollower(st);
    return;
  }

  await sleep(randomBetween(1000, 4000));

  const count         = randomBetween(st.settings.likesMin ?? 1, st.settings.likesMax ?? 3);
  const selectedPosts = selectPostsByWeight(postLinks, count);

  await patchState({ phase: 'post', postQueue: selectedPosts });
  navigate(`https://www.instagram.com${selectedPosts[0]}`);
}

// ─── PHASE: post ───────────────────────────────────────────────────────────────
async function runPost(st) {
  if (!window.location.pathname.includes('/p/')) {
    await goToNextFollower(st);
    return;
  }

  await waitFor(() => document.querySelector('article'), 8000);

  const shortcodeMatch = window.location.pathname.match(/\/p\/([^/]+)/);
  if (!shortcodeMatch) { await goToNextFollower(st); return; }

  if (isAlreadyLiked()) {
    sendStatus(`@${st.currentFollower} — вже лайкнуто, пропускаю профіль`);
    await finishProfile(st);
    return;
  }

  await sleep(randomBetween(1000, 4000));

  sendStatus('Лайкаю пост...');
  const mediaId = shortcodeToMediaId(shortcodeMatch[1]);
  const liked   = await likeViaAPI(mediaId);

  if (liked) {
    const stats = st.stats || { likes: 0, profiles: 0 };
    stats.likes++;
    const profileLikes = (st.profileLikes || 0) + 1;
    await patchState({ stats, profileLikes });
    chrome.runtime.sendMessage({ type: 'stats', data: stats }).catch(() => {});
    sendStatus(`Лайк ✓ (всього: ${stats.likes})`);
  }

  const delay = randomBetween(
    (st.settings.delayBetweenLikes    ?? 5)  * 1000,
    (st.settings.delayBetweenLikesMax ?? 15) * 1000
  );
  sendStatus(`Пауза ${Math.round(delay / 1000)}с між лайками...`);
  await sleepCheck(delay);

  const freshState = await getState();
  if (!freshState.running) return;

  const remaining = (freshState.postQueue || []).slice(1);
  await patchState({ postQueue: remaining });

  if (remaining.length > 0) {
    navigate(`https://www.instagram.com${remaining[0]}`);
  } else {
    await finishProfile(freshState);
  }
}

// ─── Завершення профілю ────────────────────────────────────────────────────────
async function finishProfile(st) {
  const stats = st.stats || { likes: 0, profiles: 0 };
  stats.profiles++;
  await patchState({ stats, phase: 'profile' });
  chrome.runtime.sendMessage({ type: 'stats', data: stats }).catch(() => {});

  await sheetsAdd(st.settings.competitor, st.currentFollower, st.profileLikes || 0);

  const profileDelay = randomBetween(
    (st.settings.delayBetweenProfiles    ?? 20) * 1000,
    (st.settings.delayBetweenProfilesMax ?? 60) * 1000
  );
  sendStatus(`Пауза ${Math.round(profileDelay / 1000)}с між профілями...`);
  await sleepCheck(profileDelay);

  const s = await getState();
  if (!s.running) return;
  await goToNextFollower(s);
}

// ─── Наступний підписник ───────────────────────────────────────────────────────
async function goToNextFollower(st) {
  const queue = st.followerQueue || [];
  if (queue.length === 0) {
    sendStatus('Всі підписники оброблені!');
    await patchState({ running: false });
    chrome.runtime.sendMessage({ type: 'done', stats: st.stats }).catch(() => {});
    return;
  }
  const next = queue[0];
  await patchState({ phase: 'profile', currentFollower: next, followerQueue: queue.slice(1), postQueue: [], profileLikes: 0 });
  navigate(`https://www.instagram.com/${next}/`);
}

// ─── Google Sheets ─────────────────────────────────────────────────────────────
async function sheetsCheck(competitor, usernames) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'sheets_check', competitor, usernames });
    return res?.filtered ?? usernames;
  } catch (e) {
    console.warn('[IGH2] sheetsCheck error:', e);
    return usernames;
  }
}

async function sheetsAdd(competitor, username, likesCount) {
  try {
    await chrome.runtime.sendMessage({
      type: 'sheets_add',
      competitor,
      username,
      likesCount,
      date: new Date().toLocaleDateString('uk-UA'),
    });
  } catch (e) {
    console.warn('[IGH2] sheetsAdd error:', e);
  }
}

async function sheetsAddHeader(sheetTab, postUrl) {
  try {
    await chrome.runtime.sendMessage({ type: 'sheets_add_header', sheetTab, postUrl });
  } catch (e) {
    console.warn('[IGH2] sheetsAddHeader error:', e);
  }
}

// ─── DOM helpers ───────────────────────────────────────────────────────────────
function getOwnUsername() {
  // Шукаємо посилання на профіль у навігації
  const navSelectors = ['nav a[href^="/"]', 'header a[href^="/"]', '[role="navigation"] a[href^="/"]'];
  for (const sel of navSelectors) {
    for (const link of document.querySelectorAll(sel)) {
      const href  = link.getAttribute('href') || '';
      const match = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
      if (match && !SYSTEM_USERNAMES.includes(match[1])) return match[1];
    }
  }
  // Fallback: будь-яке посилання з img всередині (аватар)
  for (const link of document.querySelectorAll('a[href^="/"]')) {
    const href  = link.getAttribute('href') || '';
    const match = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
    if (!match || SYSTEM_USERNAMES.includes(match[1])) continue;
    if (link.querySelector('img')) return match[1];
  }
  return null;
}

function getAuthorFromDom() {
  // 1. og:title — найнадійніший: "username on Instagram: ..."
  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) {
    const content = ogTitle.getAttribute('content') || '';
    const m = content.match(/^([a-zA-Z0-9._]+)\s+(?:on|•)/i);
    if (m && !SYSTEM_USERNAMES.includes(m[1])) return m[1];
  }

  // 2. article — перше посилання на профіль
  const article = document.querySelector('article');
  if (article) {
    for (const link of article.querySelectorAll('a[href^="/"]')) {
      const href  = link.getAttribute('href') || '';
      const match = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
      if (match && !SYSTEM_USERNAMES.includes(match[1])) return match[1];
    }
  }

  return null;
}

function isPrivateProfile() {
  const text = document.body.innerText || '';
  return text.includes('This Account is Private') ||
         text.includes('Цей акаунт закрито') ||
         text.includes('This account is private');
}

function isAlreadyLiked() {
  for (const svg of document.querySelectorAll('svg')) {
    const label = svg.getAttribute('aria-label') || '';
    if (label === 'Unlike' || label === 'Не подобається') return true;
  }
  return !!document.querySelector('button[aria-label="Unlike"]') ||
         !!document.querySelector('button[aria-label="Не подобається"]');
}

// ─── Like API ──────────────────────────────────────────────────────────────────
async function likeViaAPI(mediaId) {
  try {
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1];
    if (!csrf) return false;
    const res = await fetch(`https://www.instagram.com/api/v1/web/likes/${mediaId}/like/`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'X-CSRFToken': csrf,
        'X-Instagram-AJAX': '1',
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': window.location.href,
      },
    });
    console.log('[IGH2] like status:', res.status);
    return res.ok;
  } catch (e) {
    console.warn('[IGH2] like error:', e);
    return false;
  }
}

// ─── Утиліти ───────────────────────────────────────────────────────────────────
function shortcodeToMediaId(shortcode) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = BigInt(0);
  for (const char of shortcode) id = id * BigInt(64) + BigInt(chars.indexOf(char));
  return id.toString();
}

function selectPostsByWeight(posts, count) {
  const weights = [47.48, 23.74, 11.87, 5.94, 2.97, 2, 2, 2, 2];
  const pool    = posts.slice(0, 9).map((p, i) => ({ p, w: weights[i] ?? 2 }));
  const selected = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const total = pool.reduce((s, x) => s + x.w, 0);
    let rand = Math.random() * total;
    for (let j = 0; j < pool.length; j++) {
      rand -= pool[j].w;
      if (rand <= 0) { selected.push(pool[j].p); pool.splice(j, 1); break; }
    }
  }
  return selected;
}

function navigate(url) { window.location.href = url; }
function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomBetween(a, b) { return Math.floor(Math.random() * (b - a + 1) + a); }

async function sleepCheck(ms) {
  const step = 500;
  let elapsed = 0;
  while (elapsed < ms) {
    await sleep(Math.min(step, ms - elapsed));
    elapsed += step;
    const st = await getState();
    if (!st.running) return;
  }
}

function waitFor(fn, timeout = 8000) {
  return new Promise(resolve => {
    const interval = setInterval(() => {
      const el = fn();
      if (el) { clearInterval(interval); clearTimeout(timer); resolve(el); }
    }, 300);
    const timer = setTimeout(() => { clearInterval(interval); resolve(null); }, timeout);
  });
}

function sendStatus(text) {
  chrome.runtime.sendMessage({ type: 'status', text }).catch(() => {});
  console.log('[IGH2]', text);
}
