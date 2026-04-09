const $ = id => document.getElementById(id);

const S = 'igh2_state';

// ─── Перемикач режиму ──────────────────────────────────────────────────────────
let currentSource     = 'followers';
let currentPostSource = 'likers';

document.querySelectorAll('.src-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    currentSource = tab.dataset.src;
    document.querySelectorAll('.src-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('secFollowers').classList.toggle('hidden', currentSource === 'post');
    $('secPost').classList.toggle('hidden',      currentSource === 'followers');
  });
});

document.querySelectorAll('#psTgl .ps-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    currentPostSource = opt.dataset.val;
    document.querySelectorAll('#psTgl .ps-opt').forEach(o => o.classList.remove('on'));
    opt.classList.add('on');
  });
});

// ─── Відновлення стану ─────────────────────────────────────────────────────────
chrome.storage.local.get(S, d => {
  const st = (d[S] || {});
  if (st.settings) {
    $('competitor').value              = st.settings.competitor              ?? '';
    $('postUrl').value                 = st.settings.postUrl                 ?? '';
    $('maxFollowers').value            = st.settings.maxFollowers            ?? 50;
    $('likesMin').value                = st.settings.likesMin                ?? 1;
    $('likesMax').value                = st.settings.likesMax                ?? 3;
    $('delayBetweenLikes').value       = st.settings.delayBetweenLikes       ?? 5;
    $('delayBetweenLikesMax').value    = st.settings.delayBetweenLikesMax    ?? 15;
    $('delayBetweenProfiles').value    = st.settings.delayBetweenProfiles    ?? 20;
    $('delayBetweenProfilesMax').value = st.settings.delayBetweenProfilesMax ?? 60;

    if (st.settings.source === 'post') {
      currentSource = 'post';
      document.querySelector('.src-tab[data-src="post"]').classList.add('active');
      document.querySelector('.src-tab[data-src="followers"]').classList.remove('active');
      $('secFollowers').classList.add('hidden');
      $('secPost').classList.remove('hidden');
    }
    if (st.settings.postSource) {
      currentPostSource = st.settings.postSource;
      document.querySelectorAll('#psTgl .ps-opt').forEach(o => {
        o.classList.toggle('on', o.dataset.val === currentPostSource);
      });
    }
  }
  if (st.stats)   updateStats(st.stats);
  if (st.running) setRunning(true, 'Працює...');
});

// ─── Повідомлення від content script ──────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'stats')  updateStats(msg.data);
  if (msg.type === 'status') { $('statusMsg').className = 'status'; $('statusMsg').textContent = msg.text; }
  if (msg.type === 'done')   setRunning(false, `Готово! Лайків: ${msg.stats?.likes ?? 0}, профілів: ${msg.stats?.profiles ?? 0}`);
});

function updateStats(s) {
  $('statLikes').textContent    = s.likes    ?? 0;
  $('statProfiles').textContent = s.profiles ?? 0;
}

function setRunning(on, text) {
  $('btnStart').style.display = on ? 'none'  : 'block';
  $('btnStop').style.display  = on ? 'block' : 'none';
  if (text) { $('statusMsg').className = 'status'; $('statusMsg').textContent = text; }
}

function getSettings() {
  return {
    source:                  currentSource,
    postUrl:                 $('postUrl').value.trim(),
    postSource:              currentPostSource,
    competitor:              $('competitor').value.trim().replace(/^@/, ''),
    maxFollowers:            parseInt($('maxFollowers').value)            || 50,
    likesMin:                parseInt($('likesMin').value)                || 1,
    likesMax:                parseInt($('likesMax').value)                || 3,
    delayBetweenLikes:       parseInt($('delayBetweenLikes').value)       || 5,
    delayBetweenLikesMax:    parseInt($('delayBetweenLikesMax').value)    || 15,
    delayBetweenProfiles:    parseInt($('delayBetweenProfiles').value)    || 20,
    delayBetweenProfilesMax: parseInt($('delayBetweenProfilesMax').value) || 60,
  };
}

// ─── Старт ────────────────────────────────────────────────────────────────────
$('btnStart').addEventListener('click', async () => {
  const settings = getSettings();

  if (currentSource === 'followers' && !settings.competitor) {
    $('statusMsg').className = 'status error';
    $('statusMsg').textContent = 'Введи акаунт конкурента!';
    return;
  }
  if (currentSource === 'post' && !settings.postUrl.includes('/p/')) {
    $('statusMsg').className = 'status error';
    $('statusMsg').textContent = 'Введи коректне посилання на пост!';
    return;
  }
  if (settings.likesMin > settings.likesMax) {
    $('statusMsg').className = 'status error';
    $('statusMsg').textContent = 'Мін лайків має бути ≤ макс';
    return;
  }

  const isPost  = currentSource === 'post';
  const phase   = isPost ? 'collect_post' : 'collect';
  const destUrl = isPost
    ? settings.postUrl
    : `https://www.instagram.com/${settings.competitor}/`;

  setRunning(true, 'Запускаю...');

  const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    chrome.tabs.sendMessage(tabs[0].id, { type: 'start', settings }).catch(() => {
      chrome.storage.local.set({
        [S]: { running: true, phase, settings, followerQueue: [], postQueue: [], stats: { likes: 0, profiles: 0 } }
      }, () => chrome.tabs.update(tabs[0].id, { url: destUrl }));
    });
  } else {
    chrome.storage.local.set({
      [S]: { running: true, phase, settings, followerQueue: [], postQueue: [], stats: { likes: 0, profiles: 0 } }
    }, () => chrome.tabs.create({ url: destUrl, active: true }));
  }
});

// ─── Стоп ─────────────────────────────────────────────────────────────────────
$('btnStop').addEventListener('click', async () => {
  chrome.storage.local.get(S, d => {
    const st = d[S] || {};
    chrome.storage.local.set({ [S]: { ...st, running: false } });
  });
  setRunning(false, 'Зупинено');
  const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'stop' }).catch(() => {});
});
