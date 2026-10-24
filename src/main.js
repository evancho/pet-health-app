import { mountAppUpdate } from './app-update.js';
import { startApp } from './app.js';
import { registerSW } from 'virtual:pwa-register';

let updateSW = async () => {};

const updates = mountAppUpdate(document, {
  apply: () => updateSW(true),
});

updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    updates.notifyNeedRefresh();
  },
  onRegisteredSW(_swUrl, registration) {
    updates.watch(registration);
  },
  onOfflineReady() {},
});

startApp();
