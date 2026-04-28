/** @file The main file. Everything in the userscript is executed from here.
 * @since 0.0.0
 */

import './polyfill.js';
import Observers from './observers.js';
import ApiManager from './apiManager.js';
import TemplateManager from './templateManager.js';
import { consoleLog, consoleWarn, debugLog, getDebugLoggingEnabled } from './utils.js';
import WindowMain from './WindowMain.js';
import WindowStats from './WindowStats.js';
import WindowBookmarks from './WindowBookmarks.js';
import WindowLeaderboard from './Windowleaderboard.js';
import { initializeTileRefreshPause, notifyCanvasChange } from './tileManager.js';
import * as icons from './icons.js';

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

  // ── Map observer for FlyTo functionality ───────────────────────────────────
  const observer = new MutationObserver(() => {
    try {
      const original = Map.prototype.values;
      Map.prototype.values = function () {
        if (Array.from(this).some(arr => arr.some(x => x && x.color))) {
          return original.call(this);
        }
        const temp = original.call(this);
        const entries = Array.from(temp);

        if(entries && entries.filter(x=>x['maps'] instanceof Set).length == 0) {
          return temp;
        }
        entries.forEach((x) => {
            if (x && x['maps'] instanceof Set) {
                Array.from(x['maps']).forEach((y) => {
                    if(y){
                      var flyTo = y.flyTo || y['flyTo'];
                      if (flyTo) {
                          window.bmmap = y;
                          Map.prototype.values = original;
                          observer.disconnect();
                      }
                    }
                });
            }
            else {
              return temp;
            }
        });

        return temp;
      };
    }
    catch (e){
      console.warn('Map observer error:', e);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

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

    const isPixelRequest = (endpointName.includes('/api/pixel/') || endpointName.includes('/paint')) && reqMethod === 'POST' && response.ok;

    // JSON → forward to userscript via postMessage
    if (contentType.includes('application/json')) {
      console.log('%c' + name + '%c: JSON endpoint "' + endpointName + '"', consoleStyle, '');
      cloned.json()
        .then(jsonData => {
          // Handle pixel placement
          if (isPixelRequest) {
            const count = (typeof jsonData.painted === 'number' && jsonData.painted > 0) ? jsonData.painted : 1;
            window.postMessage({ source: 'blue-marble-pixel-placed', count: count }, '*');
          }
          // Forward all JSON data
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
  // Optimized font loading with preload
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
const windowLeaderboard = new WindowLeaderboard({ name, version, windowStats, apiManager });

windowMain.setApiManager(apiManager);
windowMain.windowStats = windowStats;
windowMain.windowLeaderboard = windowLeaderboard;
templateManager.setWindowMain(windowMain);

// ─── Initialize tile manager with smart caching ───────────────────────────────
initializeTileRefreshPause(templateManager);
debugLog('[Main] Tile manager initialized with smart caching');

// ─── Pixel-placed listener (in userscript scope where windowStats lives) ──────
window.addEventListener('message', (event) => {
  if (event.data?.source === 'blue-marble-pixel-placed') {
    windowStats.recordPixel(event.data.count ?? 1);
    notifyCanvasChange(); // Notify tile cache of canvas change
  }
});

// ─── Intercept Paint Pixel button for batch painting ──────────────────────────
const observePaintButton = new MutationObserver(() => {
  const buttons = document.querySelectorAll('button');
  for (const button of buttons) {
    if (button.textContent.includes('Paint') && !button.dataset.bmIntercepted) {
      button.dataset.bmIntercepted = 'true';

      button.addEventListener('click', async (e) => {
        if (windowMain.quickPaintQueue && windowMain.quickPaintQueue.length > 0) {
          e.preventDefault();
          e.stopImmediatePropagation();

          console.log(`Sending ${windowMain.quickPaintQueue.length} pixels to server...`);
          windowMain.handleDisplayStatus(`Sending ${windowMain.quickPaintQueue.length} pixels to server...`);

          const result = await apiManager.placePixelsBatch(windowMain.quickPaintQueue);

          if (result.success) {
            windowMain.handleDisplayStatus(`Successfully painted ${result.painted} pixels!`);
            windowStats.recordPixel(result.painted);
            notifyCanvasChange();
          } else if (result.challengeRequired) {
            windowMain.handleDisplayError('Challenge required! Please paint 1 pixel manually first.');
          } else {
            windowMain.handleDisplayError(result.error || 'Failed to paint pixels');
          }

          windowMain.quickPaintQueue = [];
        }
      }, true);
    }
  }
});

observePaintButton.observe(document.body, { childList: true, subtree: true });


// ─── Hotkeys ──────────────────────────────────────────────────────────────────

const bmHotkeys = (e) => {
  if (e.repeat) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

  if (e.code !== 'KeyX') return;

  e.preventDefault();
  e.stopImmediatePropagation();

  if (e.shiftKey) {
    // Shift+X toggles X-Mode
    const enabled = templateManager.toggleXMode();
    windowMain.handleDisplayStatus(`X-mode: ${enabled ? 'ON' : 'OFF'}`);
    return;
  }

  // X without Shift toggles X-mode background
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

windowMain.buildWindow();

apiManager.spontaneousResponseListener(windowMain);

observeBlack();
addPercentagesToPalette(windowMain);

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

// ─── addPercentagesToPalette ──────────────────────────────────────────────────

function addPercentagesToPalette(windowMain) {
  let updateInterval = null;

  const updatePercentages = () => {
    // Проверяем, что windowFilter существует и обновляем статистику
    if (!windowMain.windowFilter) {
      debugLog('[Palette %] WindowFilter not found');
      return;
    }

    // Принудительно обновляем статистику пикселей
    try {
      windowMain.windowFilter.updatePixelStatistics();
      debugLog('[Palette %] Statistics updated');
    } catch (e) {
      debugLog('[Palette %] Error updating statistics:', e);
    }

    let updatedCount = 0;
    let createdCount = 0;

    // Получаем все цвета палитры (id от 0 до 63)
    for (let colorId = 0; colorId <= 63; colorId++) {
      const colorElement = document.querySelector(`#color-${colorId}`);
      if (!colorElement) continue;

      // Получаем статистику для этого цвета из WindowFilter
      const colorStats = windowMain.windowFilter.allPixelsCorrect?.get(colorId);
      const colorTotal = windowMain.windowFilter.allPixelsColor?.get(colorId);

      // Ищем существующий элемент процента
      let percentSpan = colorElement.querySelector('.bm-palette-percent');

      if (colorStats !== undefined && colorTotal !== undefined && colorTotal > 0) {
        const percent = ((colorStats / colorTotal) * 100).toFixed(1);

        // Если элемент уже существует, просто обновляем текст
        if (percentSpan) {
          percentSpan.textContent = `${percent}%`;
          updatedCount++;
        } else {
          // Создаём новый элемент для отображения процента
          percentSpan = document.createElement('span');
          percentSpan.className = 'bm-palette-percent';
          percentSpan.textContent = `${percent}%`;
          percentSpan.style.cssText = `
            position: absolute;
            top: 2px;
            right: 2px;
            font-size: 10px;
            font-weight: bold;
            color: white;
            text-shadow: 0 0 3px black, 0 0 3px black, 0 0 3px black;
            opacity: 0;
            transition: opacity 0.3s ease;
            pointer-events: none;
            z-index: 10;
            background: rgba(0, 0, 0, 0.5);
            padding: 2px 4px;
            border-radius: 3px;
          `;

          // Добавляем элемент в цвет палитры
          if (colorElement.style.position !== 'relative' && colorElement.style.position !== 'absolute') {
            colorElement.style.position = 'relative';
          }
          colorElement.appendChild(percentSpan);
          createdCount++;

          // Добавляем обработчики для hover эффекта
          colorElement.addEventListener('mouseenter', () => {
            const span = colorElement.querySelector('.bm-palette-percent');
            if (span) span.style.opacity = '1';
          });
          colorElement.addEventListener('mouseleave', () => {
            const span = colorElement.querySelector('.bm-palette-percent');
            if (span) span.style.opacity = '0';
          });
        }
      } else if (percentSpan) {
        // Если нет данных, удаляем элемент
        percentSpan.remove();
      }
    }

    if (createdCount > 0 || updatedCount > 0) {
      debugLog(`[Palette %] Created: ${createdCount}, Updated: ${updatedCount}`);
    }
  };

  const observer = new MutationObserver(() => {
    // Проверяем наличие палитры
    const firstColor = document.querySelector('#color-0') || document.querySelector('#color-1');

    if (firstColor && !updateInterval) {
      debugLog('[Palette %] Palette found, starting updates');
      // Запускаем периодическое обновление процентов
      updatePercentages();
      updateInterval = setInterval(updatePercentages, 2000); // Обновляем каждые 2 секунды
    } else if (!firstColor && updateInterval) {
      debugLog('[Palette %] Palette lost, stopping updates');
      // Останавливаем обновление, если палитра исчезла
      clearInterval(updateInterval);
      updateInterval = null;
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}