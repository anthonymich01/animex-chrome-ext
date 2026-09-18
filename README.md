# AnimeX Playback QoL

A small Manifest V3 Chrome extension for `animex.one` that:

- keeps the player fullscreen preference across episode changes, including Auto-play next;
- restores the last player volume in every episode;
- keeps the whole Chrome window fullscreen across iframe and episode navigation, with a viewport fallback if native fullscreen is unavailable.

## Install locally

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Refresh any already-open AnimeX tabs.

The content script runs on both the AnimeX watch page and its cross-origin player at `plyr.animex.one`, which is required because the video is inside an iframe. The background service worker uses Chrome's window API to keep the browser window itself fullscreen after the iframe is replaced.
