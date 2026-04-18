/** @file The main file. Everything in the userscript is executed from here.
 * @since 0.0.0
 */

import Observers from './observers.js';
import ApiManager from './apiManager.js';
import TemplateManager from './templateManager.js';
import { consoleLog, consoleWarn } from './utils.js';
import WindowMain from './WindowMain.js';
import WindowStats from './WindowStats.js';
import WindowBookmarks from './WindowBookmarks.js';
import WindowTelemetry from './WindowTelemetry.js';
import SettingsManager from './settingsManager.js';

const name = GM_info.script.name.toString();
const version = GM_info.script.version.toString();
const consoleStyle = 'color: cornflowerblue;';

// ─── Fetch interceptor (injected into page scope via blob: URL) ───────────────
// We can't use textContent injection (CSP blocks unsafe-eval in Tampermonkey
// content scripts). Instead we compile the code into a Blob, create an object
// URL, and load it as a <script src="blob:...">. Blob URLs are allowed by
// Wplace's CSP ("blob:" is in the script-src allowlist).

function injectViaBlob(code) {
  const blob = new Blob([code], { type: 'application/javascript' });
  const url  = URL.createObjectURL(blob);
  const script = document.createElement('script');
  script.src = url;
  script.onload = () => URL.revokeObjectURL(url); // cleanup
  document.documentElement.appendChild(script);
  script.remove();
}

injectViaBlob(`
(function() {
  const name = ${JSON.stringify(name)};
  const consoleStyle = ${JSON.stringify(consoleStyle)};
  const fetchedBlobQueue = new Map();

  // ── Receive processed tile blobs back from apiManager ──────────────────────
  window.addEventListener('message', (event) => {
    if (!event.data) return;
    const { source, endpoint, blobID, blobData, blink } = event.data;
    if (!source) return;

    if (source === 'blue-marble' && !!blobID && !!blobData && !endpoint) {
      const elapsed = Date.now() - (blink ?? Date.now());
      console.groupCollapsed('%c' + name + '%c: ' + fetchedBlobQueue.size + ' Received IMAGE blob "' + blobID + '"', consoleStyle, '');
      console.log('Blob fetch took ' + String(Math.floor(elapsed/60000)).padStart(2,'0') + ':' + String(Math.floor(elapsed/1000) % 60).padStart(2,'0') + '.' + String(elapsed % 1000).padStart(3,'0') + ' MM:SS.mmm');
      console.groupEnd();

      const callback = fetchedBlobQueue.get(blobID);
      if (typeof callback === 'function') {
        callback(blobData);
      } else {
        console.warn('%c' + name + '%c: blob "' + blobID + '" not in queue, skipping', consoleStyle, '');
      }
      fetchedBlobQueue.delete(blobID);
    }
  });

  // ── Intercept fetch ────────────────────────────────────────────────────────
  const originalFetch = window.fetch;

  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    const cloned   = response.clone();

    const endpointName = ((args[0] instanceof Request) ? args[0].url : args[0]) || 'ignore';
    const contentType  = cloned.headers.get('content-type') || '';

    // Pixel placed — detect any successful request to /api/pixel/
    // Wplace may call fetch(url, {method:'POST'}) or fetch(new Request(...))
    // so we check all possible ways method could be POST, or just trust the endpoint
    const reqMethod = (
      (args[0] instanceof Request ? args[0].method : null) ||
      args[1]?.method ||
      'GET'
    ).toUpperCase();

    if ((endpointName.includes('/api/pixel/') || endpointName.includes('/paint')) && reqMethod === 'POST' && response.ok) {
      // Read how many pixels were actually painted from the response
      cloned.json()
        .then(data => {
          const count = (typeof data.painted === 'number' && data.painted > 0) ? data.painted : 1;
          window.postMessage({ source: 'blue-marble-pixel-placed', count: count }, '*');
        })
        .catch(() => {
          window.postMessage({ source: 'blue-marble-pixel-placed', count: 1 }, '*');
        });
    }

    // JSON → forward to userscript via postMessage
    if (contentType.includes('application/json')) {
      console.log('%c' + name + '%c: JSON endpoint "' + endpointName + '"', consoleStyle, '');
      cloned.json()
        .then(jsonData => {
          window.postMessage({
            source:   'blue-marble',
            endpoint: endpointName,
            jsonData: jsonData
          }, '*');
        })
        .catch(err => console.error('%c' + name + '%c: Failed to parse JSON:', consoleStyle, '', err));
    }

    // Image tile → intercept for template overlay processing
    else if (contentType.includes('image/') && !endpointName.includes('openfreemap') && !endpointName.includes('maps')) {
      const blink = Date.now();
      const blob  = await cloned.blob();

      console.log('%c' + name + '%c: ' + fetchedBlobQueue.size + ' IMAGE endpoint "' + endpointName + '"', consoleStyle, '');

      return new Promise((resolve) => {
        const blobUUID = crypto.randomUUID();

        fetchedBlobQueue.set(blobUUID, (blobProcessed) => {
          resolve(new Response(blobProcessed, {
            headers:    cloned.headers,
            status:     cloned.status,
            statusText: cloned.statusText
          }));
          console.log('%c' + name + '%c: ' + fetchedBlobQueue.size + ' Processed blob "' + blobUUID + '"', consoleStyle, '');
        });

        window.postMessage({
          source:   'blue-marble',
          endpoint: endpointName,
          blobID:   blobUUID,
          blobData: blob,
          blink:    blink
        });
      }).catch(exception => {
        console.error('%c' + name + '%c: Failed to Promise blob!', consoleStyle, '');
        console.error(exception);
      });
    }

    return response;
  };
})();
`);

// ─── CSS / font ───────────────────────────────────────────────────────────────

const cssOverlay = GM_getResourceText("CSS-BM-File");
GM_addStyle(cssOverlay);

const robotoMonoInjectionPoint = 'robotoMonoInjectionPoint';

if (!!(robotoMonoInjectionPoint.indexOf('@font-face') + 1)) {
  console.log(`Loading Roboto Mono as a file...`);
  GM_addStyle(robotoMonoInjectionPoint);
} else {
  var stylesheetLink = document.createElement('link');
  stylesheetLink.href = 'https://fonts.googleapis.com/css2?family=Roboto+Mono:ital,wght@0,100..700;1,100..700&display=swap';
  stylesheetLink.rel = 'preload';
  stylesheetLink.as = 'style';
  stylesheetLink.onload = function () {
    this.onload = null;
    this.rel = 'stylesheet';
  };
  document.head?.appendChild(stylesheetLink);
}

// ─── Constructors ─────────────────────────────────────────────────────────────

const userSettings = JSON.parse(GM_getValue('bmUserSettings', '{}'));

const observers   = new Observers();
const windowMain  = new WindowMain(name, version);
const windowStats = new WindowStats(windowMain);
const templateManager = new TemplateManager(name, version);
const apiManager  = new ApiManager(templateManager);
const settingsManager = new SettingsManager(name, version, userSettings);

windowMain.setSettingsManager(settingsManager);
windowMain.setApiManager(apiManager);
windowMain.windowStats = windowStats;
templateManager.setWindowMain(windowMain);
templateManager.setSettingsManager(settingsManager);

// ─── Pixel-placed listener (in userscript scope where windowStats lives) ──────
window.addEventListener('message', (event) => {
  if (event.data?.source === 'blue-marble-pixel-placed') {
    windowStats.recordPixel(event.data.count ?? 1);
  }
});

// ─── Hotkeys ──────────────────────────────────────────────────────────────────

const bmHotkeys = (e) => {
  if (e.repeat) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.code !== 'KeyX') return;

  e.preventDefault();
  e.stopImmediatePropagation();

  if (e.shiftKey) {
    const enabled = templateManager.toggleXMode();
    windowMain.handleDisplayStatus(`X-mode: ${enabled ? 'ON' : 'OFF'}`);
    return;
  }

  const bg = templateManager.toggleXBackground();
  if (!bg) return;
  windowMain.handleDisplayStatus(`X-mode BG: ${bg.css}`);
};

window.addEventListener('keydown', bmHotkeys, true);

// ─── Storage / init ───────────────────────────────────────────────────────────

const storageTemplates = JSON.parse(GM_getValue('bmTemplates', '{}'));
console.log(storageTemplates);
templateManager.importJSON(storageTemplates);

console.log(userSettings);
console.log(Object.keys(userSettings).length);

if (Object.keys(userSettings).length == 0) {
  const uuid = crypto.randomUUID();
  console.log(uuid);
  GM.setValue('bmUserSettings', JSON.stringify({ 'uuid': uuid }));
}

setInterval(() => apiManager.sendHeartbeat(version), 1000 * 60 * 30);

const currentTelemetryVersion = 1;
const previousTelemetryVersion = userSettings?.telemetry;
console.log(`Telemetry is ${!(previousTelemetryVersion == undefined)}`);

if ((previousTelemetryVersion == undefined) || (previousTelemetryVersion > currentTelemetryVersion)) {
  const windowTelemetry = new WindowTelemetry(name, version, currentTelemetryVersion, userSettings?.uuid);
  windowTelemetry.setApiManager(apiManager);
  windowTelemetry.buildWindow();
}

windowMain.buildWindow();

apiManager.spontaneousResponseListener(windowMain);

observeBlack();

consoleLog(`%c${name}%c (${version}) loaded!`, 'color: cornflowerblue;', '');

// ─── observeBlack ─────────────────────────────────────────────────────────────

function observeBlack() {
  const observer = new MutationObserver(() => {
    const black = document.querySelector('#color-1');
    if (!black) { return; }

    let move = document.querySelector('#bm-button-move');
    if (!move) {
      move = document.createElement('button');
      move.id = 'bm-button-move';
      move.textContent = 'Move ↑';
      move.className = 'btn btn-soft';
      move.onclick = function() {
        const roundedBox = this.parentNode.parentNode.parentNode.parentNode;
        const shouldMoveUp = (this.textContent == 'Move ↑');
        roundedBox.parentNode.className = roundedBox.parentNode.className.replace(shouldMoveUp ? 'bottom' : 'top', shouldMoveUp ? 'top' : 'bottom');
        roundedBox.style.borderTopLeftRadius    = shouldMoveUp ? '0px' : 'var(--radius-box)';
        roundedBox.style.borderTopRightRadius   = shouldMoveUp ? '0px' : 'var(--radius-box)';
        roundedBox.style.borderBottomLeftRadius  = shouldMoveUp ? 'var(--radius-box)' : '0px';
        roundedBox.style.borderBottomRightRadius = shouldMoveUp ? 'var(--radius-box)' : '0px';
        this.textContent = shouldMoveUp ? 'Move ↓' : 'Move ↑';
      };
      const paintPixel = black.parentNode.parentNode.parentNode.parentNode.querySelector('h2');
      paintPixel.parentNode?.appendChild(move);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}