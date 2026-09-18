(() => {
  'use strict';

  const PLAYER_HOST = 'plyr.animex.one';
  const HOST_ORIGINS = new Set([
    'https://animex.one',
    'https://www.animex.one'
  ]);
  const PLAYER_ORIGIN = `https://${PLAYER_HOST}`;
  const MESSAGE_SOURCE = 'animex-qol';

  // These keys are intentionally separate from AnimeX's own player settings.
  const VOLUME_KEY = 'animex-qol-volume-v1';
  const PLAYER_FULLSCREEN_KEY = 'animex-qol-player-fullscreen-v1';
  const HOST_FULLSCREEN_KEY = 'animex-qol-host-fullscreen-v1';

  const hostname = window.location.hostname.toLowerCase();

  if (hostname === PLAYER_HOST) {
    initPlayer();
  } else if (
    (hostname === 'animex.one' || hostname === 'www.animex.one') &&
    window.top === window
  ) {
    initHostPage();
  }

  function getItem(storage, key) {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  }

  function setItem(storage, key, value) {
    try {
      storage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function readBoolean(storage, key) {
    const value = getItem(storage, key);
    if (value === '1') return true;
    if (value === '0') return false;
    return null;
  }

  function clampVolume(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;

    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.min(1, Math.max(0, number));
  }

  function readSavedVolume() {
    const localVolume = clampVolume(getItem(window.localStorage, VOLUME_KEY));
    if (localVolume !== null) return localVolume;
    return clampVolume(getItem(window.sessionStorage, VOLUME_KEY));
  }

  function getParentOrigin() {
    const candidates = [];

    try {
      if (document.referrer) candidates.push(new URL(document.referrer).origin);
    } catch {
      // Ignore malformed referrers.
    }

    try {
      for (const origin of window.location.ancestorOrigins || []) {
        candidates.push(origin);
      }
    } catch {
      // ancestorOrigins is not available in every browser.
    }

    return candidates.find((origin) => HOST_ORIGINS.has(origin)) || 'https://animex.one';
  }

  function postToHost(message) {
    if (window.parent === window) return;

    try {
      window.parent.postMessage(
        { source: MESSAGE_SOURCE, version: 1, ...message },
        getParentOrigin()
      );
    } catch {
      // A closing/navigating frame can reject postMessage.
    }
  }

  function isHostMessage(event) {
    return (
      HOST_ORIGINS.has(event.origin) &&
      event.source === window.parent &&
      event.data &&
      event.data.source === MESSAGE_SOURCE
    );
  }

  function initPlayer() {
    let savedVolume = readSavedVolume();
    let userInteractionUntil = 0;
    let applyingVolume = 0;
    let leavingPage = false;
    let exitTimer = null;
    let restoreInFlight = false;
    let restoreNeeded = readBoolean(window.sessionStorage, PLAYER_FULLSCREEN_KEY) === true;
    let hadFullscreen = isFullscreen();
    let lastReportedFullscreen = null;

    const attachedVideos = new WeakSet();
    const restoreTimers = new Set();

    function reportFullscreen(active, force = false) {
      if (!force && lastReportedFullscreen === active) return;
      lastReportedFullscreen = active;
      postToHost({ type: 'fullscreen', active });
    }

    function rememberFullscreen(active) {
      setItem(window.sessionStorage, PLAYER_FULLSCREEN_KEY, active ? '1' : '0');
      reportFullscreen(active);
    }

    function isFullscreen() {
      if (document.fullscreenElement || document.webkitFullscreenElement) return true;

      return [...document.querySelectorAll('video')].some(
        (video) => video.webkitDisplayingFullscreen === true
      );
    }

    function clearExitTimer() {
      if (exitTimer !== null) {
        window.clearTimeout(exitTimer);
        exitTimer = null;
      }
    }

    function clearRestoreTimers() {
      for (const timer of restoreTimers) window.clearTimeout(timer);
      restoreTimers.clear();
    }

    function handleFullscreenChange() {
      const active = isFullscreen();

      if (active) {
        clearExitTimer();
        clearRestoreTimers();
        hadFullscreen = true;
        restoreNeeded = false;
        setItem(window.sessionStorage, PLAYER_FULLSCREEN_KEY, '1');
        reportFullscreen(true);
        return;
      }

      // A newly loaded episode starts outside fullscreen, so only handle an
      // exit if this document had actually entered fullscreen.
      if (!hadFullscreen) return;
      hadFullscreen = false;
      clearExitTimer();

      // Navigating an iframe can emit fullscreenchange while its old document
      // is being discarded. Preserve the preference in that case. An explicit
      // Escape/button exit happens while the document is still visible.
      if (leavingPage || document.visibilityState === 'hidden') return;

      exitTimer = window.setTimeout(() => {
        exitTimer = null;
        if (leavingPage || document.visibilityState === 'hidden' || isFullscreen()) return;
        restoreNeeded = false;
        rememberFullscreen(false);
      }, 400);
    }

    function markPageLeaving() {
      leavingPage = true;
      clearExitTimer();
      clearRestoreTimers();
    }

    function getFullscreenTarget() {
      return (
        document.querySelector('media-container') ||
        document.querySelector('.vjs-ejected') ||
        document.querySelector('video')
      );
    }

    async function tryRestoreNativeFullscreen() {
      if (!restoreNeeded || leavingPage || isFullscreen() || restoreInFlight) return;

      const target = getFullscreenTarget();
      if (!target) return;

      const request = target.requestFullscreen || target.webkitRequestFullscreen;
      if (typeof request !== 'function') return;

      restoreInFlight = true;
      try {
        await request.call(target);
      } catch {
        // Some Chrome versions require a user gesture here. The host page and
        // extension window fallbacks keep playback fullscreen in that case.
      } finally {
        restoreInFlight = false;
      }

      if (isFullscreen()) {
        clearRestoreTimers();
        restoreNeeded = false;
        hadFullscreen = true;
        setItem(window.sessionStorage, PLAYER_FULLSCREEN_KEY, '1');
        reportFullscreen(true);
      }
    }

    function scheduleNativeFullscreenRestore() {
      if (!restoreNeeded) return;

      clearRestoreTimers();

      // The video element is created asynchronously by the HLS player. Try at
      // several useful lifecycle points instead of relying on one load event.
      for (const delay of [0, 100, 350, 800, 1500, 3000, 5000]) {
        const timer = window.setTimeout(() => {
          restoreTimers.delete(timer);
          void tryRestoreNativeFullscreen();
        }, delay);
        restoreTimers.add(timer);
      }
    }

    function isVolumeControl(target) {
      return (
        target instanceof Element &&
        target.closest(
          'media-volume-slider, [aria-label="Volume"], [aria-label^="Volume"], .volume-expand'
        ) !== null
      );
    }

    function markUserVolumeInteraction(event) {
      const key = typeof event.key === 'string' ? event.key : '';
      const keyboardVolumeChange = key === 'ArrowUp' || key === 'ArrowDown';
      const pointerVolumeChange = isVolumeControl(event.target);

      if (keyboardVolumeChange || pointerVolumeChange) {
        userInteractionUntil = performance.now() + 1000;
      }
    }

    function saveVolume(value) {
      const volume = clampVolume(value);
      if (volume === null) return;

      savedVolume = volume;
      setItem(window.localStorage, VOLUME_KEY, String(volume));
      setItem(window.sessionStorage, VOLUME_KEY, String(volume));
      postToHost({ type: 'volume', volume });
    }

    function applySavedVolume(video) {
      if (savedVolume === null || !video) return;
      if (Math.abs(video.volume - savedVolume) < 0.005) return;

      applyingVolume += 1;
      try {
        video.volume = savedVolume;
      } catch {
        // A media provider may temporarily expose a read-only media element.
      } finally {
        applyingVolume -= 1;
      }
    }

    function saveVolumeFromVideos() {
      if (performance.now() > userInteractionUntil) return;
      const video = document.querySelector('video');
      if (video) saveVolume(video.volume);
    }

    function handleVolumeChange(video) {
      if (applyingVolume > 0) return;

      const volume = clampVolume(video.volume);
      if (volume === null) return;

      if (performance.now() <= userInteractionUntil) {
        saveVolume(volume);
        return;
      }

      // AnimeX sends its global default (normally 100%) to the embedded player
      // whenever a new episode becomes ready. Restore our value rather than
      // treating that programmatic update as a new user preference.
      applySavedVolume(video);
    }

    function attachVideo(video) {
      if (attachedVideos.has(video)) return;
      attachedVideos.add(video);

      video.addEventListener('volumechange', () => handleVolumeChange(video));
      for (const eventName of ['loadeddata', 'loadedmetadata', 'canplay', 'playing']) {
        video.addEventListener(eventName, () => {
          applySavedVolume(video);
          void tryRestoreNativeFullscreen();
        });
      }

      applySavedVolume(video);
      void tryRestoreNativeFullscreen();
    }

    function scanVideos() {
      for (const video of document.querySelectorAll('video')) attachVideo(video);
      if (restoreNeeded) void tryRestoreNativeFullscreen();
    }

    function handlePlayerMessage(event) {
      const message = event.data;

      // The embedding page uses this command after every episode is ready.
      // Re-apply after it has reached the media element, even if its own
      // volumechange listener runs first.
      if (
        message &&
        message.source === 'aniembed' &&
        message.type === 'command' &&
        message.name === 'setVolume' &&
        HOST_ORIGINS.has(event.origin) &&
        event.source === window.parent
      ) {
        for (const delay of [0, 50, 250]) {
          window.setTimeout(scanVideos, delay);
        }
        return;
      }

      if (!isHostMessage(event)) return;

      if (message.type === 'restore') {
        const restoredVolume = clampVolume(message.volume);
        if (restoredVolume !== null) {
          savedVolume = restoredVolume;
          setItem(window.localStorage, VOLUME_KEY, String(restoredVolume));
          setItem(window.sessionStorage, VOLUME_KEY, String(restoredVolume));
        }

        if (message.fullscreen === true) {
          restoreNeeded = true;
          setItem(window.sessionStorage, PLAYER_FULLSCREEN_KEY, '1');
          reportFullscreen(true);
          scheduleNativeFullscreenRestore();
        } else if (message.fullscreen === false) {
          restoreNeeded = false;
          hadFullscreen = false;
          clearRestoreTimers();
          setItem(window.sessionStorage, PLAYER_FULLSCREEN_KEY, '0');
          reportFullscreen(false, true);

          if (isFullscreen()) {
            const exit = document.exitFullscreen || document.webkitExitFullscreen;
            if (typeof exit === 'function') {
              try {
                Promise.resolve(exit.call(document)).catch(() => {});
              } catch {
                // The document may already be navigating out of fullscreen.
              }
            }
          }
        }
        scanVideos();
      }
    }

    function handleStorageChange(event) {
      if (event.key !== VOLUME_KEY) return;
      savedVolume = readSavedVolume();
      if (savedVolume !== null) scanVideos();
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('keydown', (event) => {
      // Escape also needs to dismiss the CSS fallback when native fullscreen
      // restoration was blocked by Chrome's user-gesture requirement.
      if (event.key !== 'Escape' || !restoreNeeded || isFullscreen()) return;
      restoreNeeded = false;
      hadFullscreen = false;
      clearRestoreTimers();
      rememberFullscreen(false);
    }, true);
    window.addEventListener('beforeunload', markPageLeaving);
    window.addEventListener('pagehide', markPageLeaving);
    window.addEventListener('message', handlePlayerMessage);
    window.addEventListener('storage', handleStorageChange);

    // Capture the interaction before AnimeX's own handler changes video.volume.
    for (const eventName of ['pointerdown', 'pointermove', 'touchstart', 'wheel', 'keydown']) {
      document.addEventListener(eventName, markUserVolumeInteraction, true);
    }
    for (const eventName of ['input', 'change']) {
      document.addEventListener(
        eventName,
        (event) => {
          if (!isVolumeControl(event.target)) return;
          userInteractionUntil = performance.now() + 1000;
          window.setTimeout(saveVolumeFromVideos, 0);
        },
        true
      );
    }

    const observer = new MutationObserver(scanVideos);
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true
    });

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', scanVideos, { once: true });
    } else {
      scanVideos();
    }

    if (restoreNeeded) {
      // Let the host apply its fullscreen state immediately, then try native
      // fullscreen in the new player document.
      reportFullscreen(true, true);
      scheduleNativeFullscreenRestore();
    }
  }

  function initHostPage() {
    const state = {
      active: false,
      wasWatchPage: isWatchPage(),
      frame: null,
      frameSrc: '',
      ignoreFalseUntil: 0,
      navigationTimer: null,
      nativeRequestInFlight: false,
      hostNativeFullscreen: false,
      suppressNativeExit: false,
      windowFullscreenRequested: null,
      observedFrames: new WeakSet()
    };

    state.active = state.wasWatchPage && readBoolean(window.sessionStorage, HOST_FULLSCREEN_KEY) === true;
    applyHostFullscreenAttribute();

    function isWatchPage() {
      return window.location.pathname === '/watch' || window.location.pathname.startsWith('/watch/');
    }

    function findPlayerFrame() {
      for (const frame of document.querySelectorAll('iframe')) {
        try {
          if (new URL(frame.src, window.location.href).hostname === PLAYER_HOST) return frame;
        } catch {
          // Ignore an iframe with an invalid or not-yet-populated src.
        }
      }
      return null;
    }

    function applyHostFullscreenAttribute() {
      if (!document.documentElement) return;
      document.documentElement.toggleAttribute('data-animex-qol-fullscreen', state.active);
    }

    function getDocumentFullscreenElement() {
      return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    function getHostFullscreenTarget() {
      return document.querySelector('#watch-player-region');
    }

    function isHostNativeFullscreen() {
      const target = getHostFullscreenTarget();
      return target !== null && getDocumentFullscreenElement() === target;
    }

    function sendWindowFullscreenCommand(active) {
      if (state.windowFullscreenRequested === active) return;
      state.windowFullscreenRequested = active;

      const runtime = typeof chrome !== 'undefined' ? chrome.runtime : null;
      if (!runtime || typeof runtime.sendMessage !== 'function') {
        state.windowFullscreenRequested = null;
        return;
      }

      try {
        runtime.sendMessage(
          { source: MESSAGE_SOURCE, type: 'window-fullscreen', active },
          (response) => {
            const failed = Boolean(runtime.lastError) || (
              active && (!response || response.active !== true)
            );

            if (!failed || !active || !state.active || state.windowFullscreenRequested !== active) {
              return;
            }

            // The service worker can be starting up while the iframe is being
            // restored. Retry once it is available instead of falling back to
            // the browser viewport forever.
            state.windowFullscreenRequested = null;
            window.setTimeout(() => {
              if (state.active && state.windowFullscreenRequested === null) {
                sendWindowFullscreenCommand(true);
              }
            }, 1000);
          }
        );
      } catch {
        state.windowFullscreenRequested = null;
      }
    }

    function exitHostNativeFullscreen() {
      const element = getDocumentFullscreenElement();
      if (!state.hostNativeFullscreen && !element) return;

      state.hostNativeFullscreen = false;
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (typeof exit !== 'function' || !element) return;

      state.suppressNativeExit = true;
      try {
        Promise.resolve(exit.call(document))
          .catch(() => {})
          .finally(() => {
            state.suppressNativeExit = false;
          });
      } catch {
        state.suppressNativeExit = false;
      }
    }

    async function requestHostNativeFullscreen() {
      if (!state.active || state.nativeRequestInFlight || isHostNativeFullscreen()) return;

      const target = getHostFullscreenTarget();
      if (!target) return;

      const request = target.requestFullscreen || target.webkitRequestFullscreen;
      if (typeof request !== 'function') return;

      state.nativeRequestInFlight = true;
      try {
        await request.call(target);
      } catch {
        // A request made after an iframe navigation may not have a transient
        // user gesture. The extension window fullscreen command is the
        // browser-wide fallback for that case.
      } finally {
        state.nativeRequestInFlight = false;
      }

      if (state.active && getDocumentFullscreenElement() === target) {
        state.hostNativeFullscreen = true;
      }
    }

    function handleHostFullscreenChange() {
      const element = getDocumentFullscreenElement();
      const target = getHostFullscreenTarget();

      if (target && element === target) {
        state.hostNativeFullscreen = true;
        return;
      }

      if (state.hostNativeFullscreen && !state.suppressNativeExit) {
        // Keep the preference while an iframe or its host player region is
        // being replaced. An actual browser-window exit is reported by the
        // service worker; the player's own exit button is handled by the
        // player content script.
        state.hostNativeFullscreen = false;
      }
    }

    function setHostFullscreen(active, persist = true) {
      if (active && !isWatchPage()) return;

      const changed = state.active !== active;
      state.active = active;
      if (persist) {
        setItem(window.sessionStorage, HOST_FULLSCREEN_KEY, active ? '1' : '0');
      }
      applyHostFullscreenAttribute();

      if (active) {
        // Try the web API first while any user activation is still available.
        void requestHostNativeFullscreen();
        // chrome.windows.update() is not subject to requestFullscreen's
        // transient-user-activation rule, so it can hide the browser chrome
        // again after the player iframe navigates.
        sendWindowFullscreenCommand(true);
      } else {
        sendWindowFullscreenCommand(false);
        exitHostNativeFullscreen();
      }

      // A restore message can cause the player to report its state back. Only
      // send it when the host state changed; otherwise the two content scripts
      // would keep acknowledging one another indefinitely.
      if (changed) sendRestoreMessage(state.frame || findPlayerFrame());
    }

    function sendRestoreMessage(frame) {
      if (!frame || !frame.contentWindow) return;

      try {
        frame.contentWindow.postMessage(
          {
            source: MESSAGE_SOURCE,
            version: 1,
            type: 'restore',
            fullscreen: state.active,
            volume: readSavedVolume()
          },
          PLAYER_ORIGIN
        );
      } catch {
        // The frame can be between documents during an episode change.
      }
    }

    function watchFrame(frame) {
      if (!frame || state.observedFrames.has(frame)) return;
      state.observedFrames.add(frame);
      frame.addEventListener('load', () => {
        sendRestoreMessage(frame);
        applyHostFullscreenAttribute();
        if (state.active) void requestHostNativeFullscreen();
      });
    }

    function syncFrame() {
      const frame = findPlayerFrame();
      const src = frame ? frame.src : '';
      const changed = frame !== state.frame || src !== state.frameSrc;

      if (changed) {
        if (state.frame && state.active) {
          // Ignore the old player's fullscreenchange=false while the iframe is
          // moving to the next episode. The new document will confirm state.
          state.ignoreFalseUntil = Date.now() + 1800;
          if (state.navigationTimer !== null) window.clearTimeout(state.navigationTimer);
          state.navigationTimer = window.setTimeout(() => {
            state.navigationTimer = null;
          }, 1800);
        }

        state.frame = frame;
        state.frameSrc = src;
        watchFrame(frame);
        sendRestoreMessage(frame);
        if (state.active) void requestHostNativeFullscreen();
      }

      applyHostFullscreenAttribute();
    }

    function updateSiteVolumeSetting(volume) {
      const value = clampVolume(volume);
      if (value === null) return;

      // If AnimeX has already persisted its settings, keep its global setting
      // in sync too. Do not create a partial settings object when it has not.
      const raw = getItem(window.localStorage, 'settings');
      if (!raw) return;

      try {
        const settings = JSON.parse(raw);
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
        settings.volume = value;
        setItem(window.localStorage, 'settings', JSON.stringify(settings));
      } catch {
        // AnimeX may have a transient/invalid settings value; the player key
        // remains the source of truth in that case.
      }
    }

    function handleMessage(event) {
      const frame = findPlayerFrame();
      const frameSrc = frame ? frame.src : '';
      if (frame !== state.frame || frameSrc !== state.frameSrc) syncFrame();

      if (
        event.origin !== PLAYER_ORIGIN ||
        !frame ||
        event.source !== frame.contentWindow ||
        !event.data ||
        event.data.source !== MESSAGE_SOURCE
      ) {
        return;
      }

      if (event.data.type === 'fullscreen') {
        if (event.data.active === true) {
          state.ignoreFalseUntil = 0;
          setHostFullscreen(true);
        } else if (event.data.active === false) {
          if (Date.now() < state.ignoreFalseUntil) return;
          setHostFullscreen(false);
        }
      } else if (event.data.type === 'volume') {
        const volume = clampVolume(event.data.volume);
        if (volume === null) return;

        // Keep top-level copies as a fallback for browsers that partition or
        // block storage in the cross-origin player iframe. AnimeX may clear
        // unknown localStorage keys, so sessionStorage is also maintained.
        setItem(window.localStorage, VOLUME_KEY, String(volume));
        setItem(window.sessionStorage, VOLUME_KEY, String(volume));
        updateSiteVolumeSetting(volume);
      }
    }

    function handleWindowFullscreenMessage(message) {
      if (
        !message ||
        message.source !== MESSAGE_SOURCE ||
        message.type !== 'window-fullscreen-state' ||
        message.active !== false
      ) {
        return;
      }

      state.windowFullscreenRequested = null;
      if (state.active) setHostFullscreen(false);
    }

    function syncRoute() {
      const watch = isWatchPage();
      if (!watch) {
        if (state.active || readBoolean(window.sessionStorage, HOST_FULLSCREEN_KEY) === true) {
          setHostFullscreen(false);
        }
      } else if (!state.wasWatchPage) {
        setHostFullscreen(readBoolean(window.sessionStorage, HOST_FULLSCREEN_KEY) === true, false);
      }
      state.wasWatchPage = watch;
      syncFrame();
    }

    document.addEventListener('DOMContentLoaded', syncRoute, { once: true });
    document.addEventListener('fullscreenchange', handleHostFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleHostFullscreenChange);
    document.addEventListener('keydown', (event) => {
      if (
        event.key === 'Escape' &&
        state.active &&
        (state.hostNativeFullscreen || !getDocumentFullscreenElement()) &&
        Date.now() >= state.ignoreFalseUntil
      ) {
        setHostFullscreen(false);
      }
    }, true);
    window.addEventListener('message', handleMessage);
    window.addEventListener('popstate', syncRoute);

    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.onMessage.addListener(handleWindowFullscreenMessage);
    }

    // AnimeX is an SPA, so the next episode can change the URL and iframe src
    // without re-running this content script.
    window.setInterval(syncRoute, 250);
    syncFrame();
    if (state.active) {
      sendWindowFullscreenCommand(true);
      void requestHostNativeFullscreen();
    }
  }
})();
