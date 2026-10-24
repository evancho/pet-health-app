const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function isInstalledDisplay(nav = globalThis.navigator, matchMedia = globalThis.matchMedia) {
  let standalone = false;
  if (typeof matchMedia === 'function') {
    standalone = Boolean(matchMedia('(display-mode: standalone)')?.matches)
      || Boolean(matchMedia('(display-mode: fullscreen)')?.matches);
  }
  return Boolean(standalone || nav?.standalone);
}

export function updatePromptCopy(installed) {
  if (installed) {
    return {
      banner: '主畫面上的寵物健康有新版本，請立即更新',
      title: '請更新寵物健康',
      body: '你加到主畫面的寵物健康已有新版本。請按「立即更新」重新載入，否則會繼續使用舊版。寵物資料仍留在這台裝置。',
    };
  }
  return {
    banner: '有新版本，請立即更新',
    title: '有新版本',
    body: '寵物健康已有新版本。請按「立即更新」重新載入，才能使用最新畫面與功能。',
  };
}

export function mountAppUpdate(doc, { apply, isInstalled = () => isInstalledDisplay() }) {
  const banner = doc.getElementById('update-banner');
  const bannerText = doc.getElementById('update-banner-text');
  const reloadBtn = doc.getElementById('reload-btn');
  const prompt = doc.getElementById('update-prompt');
  const title = doc.getElementById('update-title');
  const body = doc.getElementById('update-copy');
  const nowBtn = doc.getElementById('update-now');
  const laterBtn = doc.getElementById('update-later');

  let waiting = false;
  let applying = false;
  let registration = null;
  let timer = 0;

  function paint() {
    const copy = updatePromptCopy(isInstalled());
    bannerText.textContent = copy.banner;
    title.textContent = copy.title;
    body.textContent = copy.body;
  }

  function showPrompt() {
    paint();
    if (!prompt.open) prompt.showModal();
    nowBtn.focus();
  }

  function hidePrompt() {
    if (prompt.open) prompt.close();
    if (!banner.hidden) reloadBtn.focus();
  }

  async function runApply() {
    if (applying) return;
    applying = true;
    nowBtn.disabled = true;
    reloadBtn.disabled = true;
    nowBtn.textContent = '正在更新…';
    reloadBtn.textContent = '正在更新…';
    try {
      await apply();
    } catch (error) {
      console.error(error);
      applying = false;
      nowBtn.disabled = false;
      reloadBtn.disabled = false;
      nowBtn.textContent = '立即更新';
      reloadBtn.textContent = '立即更新';
      body.textContent = '更新沒有完成。請再按一次「立即更新」。';
    }
  }

  function notifyNeedRefresh() {
    waiting = true;
    paint();
    banner.hidden = false;
    showPrompt();
  }

  function checkForUpdate() {
    if (!registration) return;
    registration.update().catch(() => {});
  }

  function watch(nextRegistration) {
    registration = nextRegistration || null;
    if (!registration || timer) return;
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState !== 'visible') return;
      checkForUpdate();
      if (waiting && isInstalled()) showPrompt();
    });
    timer = setInterval(checkForUpdate, CHECK_INTERVAL_MS);
  }

  reloadBtn.addEventListener('click', () => runApply());
  nowBtn.addEventListener('click', () => runApply());
  laterBtn.addEventListener('click', hidePrompt);
  prompt.addEventListener('cancel', (event) => {
    event.preventDefault();
    hidePrompt();
  });

  return { notifyNeedRefresh, watch };
}
