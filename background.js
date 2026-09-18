(() => {
  'use strict';

  const MESSAGE_SOURCE = 'animex-qol';
  const STORAGE_PREFIX = 'animex-qol-window-fullscreen-';
  const records = new Map();

  function storageKey(windowId) {
    return `${STORAGE_PREFIX}${windowId}`;
  }

  function sessionStorageArea() {
    return typeof chrome !== 'undefined' && chrome.storage
      ? chrome.storage.session
      : null;
  }

  async function readRecord(windowId) {
    if (records.has(windowId)) return records.get(windowId);

    const storage = sessionStorageArea();
    if (!storage) return null;

    try {
      const result = await storage.get(storageKey(windowId));
      const record = result[storageKey(windowId)];
      if (record && typeof record === 'object') {
        records.set(windowId, record);
        return record;
      }
    } catch {
      // The in-memory record is still enough while the service worker lives.
    }

    return null;
  }

  async function writeRecord(windowId, record) {
    records.set(windowId, record);

    const storage = sessionStorageArea();
    if (!storage) return;

    try {
      await storage.set({ [storageKey(windowId)]: record });
    } catch {
      // Ignore storage failures; the window operation can still proceed.
    }
  }

  async function removeRecord(windowId) {
    records.delete(windowId);

    const storage = sessionStorageArea();
    if (!storage) return;

    try {
      await storage.remove(storageKey(windowId));
    } catch {
      // Ignore storage failures.
    }
  }

  function restoreState(value) {
    return value === 'maximized' ? 'maximized' : 'normal';
  }

  async function getWindow(windowId) {
    try {
      return await chrome.windows.get(windowId);
    } catch {
      return null;
    }
  }

  async function enterWindowFullscreen(windowId, tabId) {
    const current = await getWindow(windowId);
    if (!current) return false;

    const existing = await readRecord(windowId);
    if (existing) {
      existing.tabId = tabId;
      await writeRecord(windowId, existing);
    } else {
      // Chrome can report fullscreen here when the player has just entered
      // native fullscreen. Keep ownership so an explicit player exit can also
      // restore the browser window after the iframe is replaced.
      await writeRecord(windowId, {
        tabId,
        owned: true,
        previousState: restoreState(current.state)
      });
    }

    if (current.state === 'fullscreen') return true;

    try {
      await chrome.windows.update(windowId, { state: 'fullscreen' });
      return true;
    } catch {
      await removeRecord(windowId);
      return false;
    }
  }

  async function leaveWindowFullscreen(windowId) {
    const record = await readRecord(windowId);
    if (!record) return false;

    await removeRecord(windowId);
    if (record.owned !== true) return true;

    const current = await getWindow(windowId);
    if (!current || current.state !== 'fullscreen') return true;

    try {
      await chrome.windows.update(windowId, {
        state: restoreState(record.previousState)
      });
    } catch {
      // The user can still leave fullscreen with Chrome's normal controls.
    }

    return true;
  }

  function notifyTab(tabId, active) {
    if (!Number.isInteger(tabId)) return;

    try {
      chrome.tabs.sendMessage(
        tabId,
        { source: MESSAGE_SOURCE, type: 'window-fullscreen-state', active },
        () => {
          // Reading lastError prevents an unhandled error when the tab is
          // navigating or no longer matches the content-script URL patterns.
          void chrome.runtime.lastError;
        }
      );
    } catch {
      // The tab may have been closed between the state change and the message.
    }
  }

  async function reconcileWindow(windowId) {
    const record = await readRecord(windowId);
    if (!record) return;

    const current = await getWindow(windowId);
    if (current && current.state === 'fullscreen') return;

    await removeRecord(windowId);
    notifyTab(record.tabId, false);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.source !== MESSAGE_SOURCE) return false;

    const windowId = sender.tab && sender.tab.windowId;
    const tabId = sender.tab && sender.tab.id;
    if (!Number.isInteger(windowId)) return false;

    if (message.type !== 'window-fullscreen') return false;

    const operation = message.active === true
      ? enterWindowFullscreen(windowId, tabId)
      : leaveWindowFullscreen(windowId);

    operation
      .then((active) => sendResponse({ active }))
      .catch(() => sendResponse({ active: false }));

    return true;
  });

  chrome.windows.onBoundsChanged.addListener((window) => {
    void reconcileWindow(window.id);
  });

  chrome.windows.onRemoved.addListener((windowId) => {
    void removeRecord(windowId);
  });
})();
