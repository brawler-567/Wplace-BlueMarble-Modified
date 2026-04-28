/** @file Tile Management for handling tile refresh pausing and performance
 * Contains logic for managing tile updates and refresh behavior
 * @since 0.91.0
 */

import { debugLog } from './utils.js';

/** Global state for tile refresh pausing */
let tileRefreshPaused = false;
let originalDrawTemplateOnTile = null;
let frozenTileCache = new Map();
let isCapturingState = false;

/** Smart tile cache system for persistent performance improvement */
let smartTileCacheEnabled = true;
let smartTileCache = new Map();
let cacheAccessOrder = new Map();
let cacheHits = 0;
let cacheMisses = 0;
let maxCacheSize = 500;
let cacheVersion = '1.0';
let lastCanvasChangeTime = 0;

/** Cache statistics and management */
const CACHE_STATS_KEY = 'bmSmartTileCacheStats';
const CACHE_VERSION_KEY = 'bmSmartTileCacheVersion';

/** Gets the tile refresh paused setting from storage
 * @returns {boolean} Whether tile refresh is paused
 * @since 0.91.0
 */
export function getTileRefreshPaused() {
  try {
    let paused = null;
    if (typeof GM_getValue !== 'undefined') {
      const saved = GM_getValue('bmTileRefreshPaused', null);
      if (saved !== null) paused = JSON.parse(saved);
    }
    if (paused === null) {
      const saved = localStorage.getItem('bmTileRefreshPaused');
      if (saved !== null) paused = JSON.parse(saved);
    }
    if (paused !== null) return paused;
  } catch (error) {
    console.warn('Failed to load tile refresh paused setting:', error);
  }
  return false;
}

/** Saves the tile refresh paused setting to storage
 * @param {boolean} paused - Whether tile refresh should be paused
 * @since 0.91.0
 */
export function saveTileRefreshPaused(paused) {
  try {
    const pausedString = JSON.stringify(paused);
    if (typeof GM_setValue !== 'undefined') {
      GM_setValue('bmTileRefreshPaused', pausedString);
    }
    localStorage.setItem('bmTileRefreshPaused', pausedString);
  } catch (error) {
    console.error('Failed to save tile refresh paused setting:', error);
  }
}

/** Gets the smart tile cache enabled setting from storage
 * @returns {boolean} Whether smart tile cache is enabled
 * @since 0.91.0
 */
export function getSmartTileCacheEnabled() {
  try {
    let enabled = null;
    if (typeof GM_getValue !== 'undefined') {
      const saved = GM_getValue('bmSmartTileCacheEnabled', null);
      if (saved !== null) enabled = JSON.parse(saved);
    }
    if (enabled === null) {
      const saved = localStorage.getItem('bmSmartTileCacheEnabled');
      if (saved !== null) enabled = JSON.parse(saved);
    }
    if (enabled !== null) return enabled;
  } catch (error) {
    console.warn('Failed to load smart tile cache setting:', error);
  }
  return true;
}

/** Saves the smart tile cache enabled setting to storage
 * @param {boolean} enabled - Whether smart tile cache should be enabled
 * @since 0.91.0
 */
export function saveSmartTileCacheEnabled(enabled) {
  try {
    const enabledString = JSON.stringify(enabled);
    if (typeof GM_setValue !== 'undefined') {
      GM_setValue('bmSmartTileCacheEnabled', enabledString);
    }
    localStorage.setItem('bmSmartTileCacheEnabled', enabledString);
  } catch (error) {
    console.error('Failed to save smart tile cache setting:', error);
  }
}

/** Notifies cache system that canvas has changed
 * @since 0.91.0
 */
export function notifyCanvasChange() {
  lastCanvasChangeTime = Date.now();
  debugLog('[Tile Cache] Canvas change detected - clearing all caches');

  // Clear smart tile cache
  if (smartTileCache.size > 0) {
    smartTileCache.clear();
    cacheAccessOrder.clear();
    debugLog(`[Tile Cache] Cleared ${smartTileCache.size} entries from smart cache`);
  }

  // Clear frozen tile cache (X-Mode cache)
  if (frozenTileCache.size > 0) {
    const frozenSize = frozenTileCache.size;
    frozenTileCache.clear();
    debugLog(`[Tile Cache] Cleared ${frozenSize} entries from frozen cache`);
  }
}

/** Initializes the smart tile cache system
 * @since 0.91.0
 */
function initializeSmartTileCache() {
  smartTileCacheEnabled = getSmartTileCacheEnabled();

  try {
    const storedVersion = localStorage.getItem(CACHE_VERSION_KEY);
    if (storedVersion !== cacheVersion) {
      debugLog('[Tile Cache] Version mismatch, clearing cache');
      clearSmartTileCache();
      localStorage.setItem(CACHE_VERSION_KEY, cacheVersion);
    }

    const stats = JSON.parse(localStorage.getItem(CACHE_STATS_KEY) || '{"hits":0,"misses":0}');
    cacheHits = stats.hits || 0;
    cacheMisses = stats.misses || 0;

    debugLog(`[Tile Cache] Initialized - Enabled: ${smartTileCacheEnabled}, Cache size: ${smartTileCache.size}`);
  } catch (error) {
    console.warn('Failed to initialize smart tile cache:', error);
    clearSmartTileCache();
  }
}

/** Generates a cache key for a tile
 * @param {Array<number>|string} tileCoords - The tile coordinates
 * @param {Array} templateArray - Current templates for hash generation
 * @param {Blob} tileBlob - The tile blob to hash for content changes
 * @returns {string} Cache key
 * @since 0.91.0
 */
function generateCacheKey(tileCoords, templateArray, tileBlob) {
  const coordsKey = Array.isArray(tileCoords) ?
    tileCoords[0].toString().padStart(4, '0') + ',' + tileCoords[1].toString().padStart(4, '0') :
    tileCoords.toString();

  let templateHash = '';
  if (templateArray && templateArray.length > 0) {
    templateHash = templateArray
      .filter(template => template.enabled !== false)
      .map(template => `${template.name || 'unnamed'}_${template.sortID || 0}`)
      .sort()
      .join('|');
  }

  let contentHash = 'nodata';
  if (tileBlob && tileBlob.size) {
    contentHash = `${tileBlob.size}_${tileBlob.type}`;
  }

  return `${coordsKey}_${templateHash}_${contentHash}`;
}

/** Updates LRU cache access order
 * @param {string} key - Cache key
 * @since 0.91.0
 */
function updateCacheAccess(key) {
  cacheAccessOrder.set(key, Date.now());
}

/** Evicts least recently used cache entries when cache is full
 * @since 0.91.0
 */
function evictLRUEntries() {
  if (smartTileCache.size <= maxCacheSize) return;

  const sortedEntries = Array.from(cacheAccessOrder.entries())
    .sort(([,a], [,b]) => a - b);

  const entriesToRemove = sortedEntries.slice(0, smartTileCache.size - maxCacheSize + 10);

  for (const [key] of entriesToRemove) {
    smartTileCache.delete(key);
    cacheAccessOrder.delete(key);
  }

  debugLog(`[Tile Cache] Evicted ${entriesToRemove.length} LRU entries, cache size now: ${smartTileCache.size}`);
}

/** Stores a processed tile in the smart cache
 * @param {string} cacheKey - The cache key
 * @param {*} processedTile - The processed tile data
 * @since 0.91.0
 */
function storeInSmartCache(cacheKey, processedTile) {
  if (!smartTileCacheEnabled) return;

  try {
    smartTileCache.set(cacheKey, processedTile);
    updateCacheAccess(cacheKey);
    evictLRUEntries();

    if ((cacheHits + cacheMisses) % 50 === 0) {
      saveCacheStatistics();
    }
  } catch (error) {
    console.warn('Failed to store tile in smart cache:', error);
  }
}

/** Retrieves a tile from the smart cache
 * @param {string} cacheKey - The cache key
 * @returns {*|null} Cached tile data or null if not found
 * @since 0.91.0
 */
function getFromSmartCache(cacheKey) {
  if (!smartTileCacheEnabled) return null;

  if (smartTileCache.has(cacheKey)) {
    updateCacheAccess(cacheKey);
    cacheHits++;
    debugLog(`[Tile Cache] HIT for key: ${cacheKey.substring(0, 20)}...`);
    return smartTileCache.get(cacheKey);
  }

  cacheMisses++;
  debugLog(`[Tile Cache] MISS for key: ${cacheKey.substring(0, 20)}...`);
  return null;
}

/** Saves cache statistics to localStorage
 * @since 0.91.0
 */
function saveCacheStatistics() {
  try {
    const stats = { hits: cacheHits, misses: cacheMisses };
    localStorage.setItem(CACHE_STATS_KEY, JSON.stringify(stats));
  } catch (error) {
    console.warn('Failed to save cache statistics:', error);
  }
}

/** Clears the smart tile cache
 * @since 0.91.0
 */
function clearSmartTileCache() {
  smartTileCache.clear();
  cacheAccessOrder.clear();
  cacheHits = 0;
  cacheMisses = 0;
  saveCacheStatistics();
  debugLog('[Tile Cache] Cache cleared');
}

/** Gets cache statistics for display
 * @returns {Object} Cache statistics
 * @since 0.91.0
 */
export function getSmartCacheStats() {
  const hitRate = cacheHits + cacheMisses > 0 ? (cacheHits / (cacheHits + cacheMisses) * 100).toFixed(1) : '0.0';
  return {
    enabled: smartTileCacheEnabled,
    size: smartTileCache.size,
    maxSize: maxCacheSize,
    hits: cacheHits,
    misses: cacheMisses,
    hitRate: `${hitRate}%`
  };
}

/** Toggles smart tile cache on/off
 * @returns {boolean} New cache state
 * @since 0.91.0
 */
export function toggleSmartTileCache() {
  smartTileCacheEnabled = !smartTileCacheEnabled;
  saveSmartTileCacheEnabled(smartTileCacheEnabled);

  if (!smartTileCacheEnabled) {
    clearSmartTileCache();
  }

  debugLog(`[Tile Cache] Toggled ${smartTileCacheEnabled ? 'ON' : 'OFF'}`);
  return smartTileCacheEnabled;
}

/** Invalidates the tile cache when visual settings change
 * @since 0.91.0
 */
export function invalidateCacheForSettingsChange() {
  if (smartTileCacheEnabled && smartTileCache.size > 0) {
    debugLog('[Tile Cache] Invalidating cache due to visual settings change');
    clearSmartTileCache();
  }
}

/** Initializes the tile refresh pause system
 * @param {Object} templateManager - The template manager instance
 * @since 0.91.0
 */
export function initializeTileRefreshPause(templateManager) {
  initializeSmartTileCache();

  tileRefreshPaused = getTileRefreshPaused();

  if (!originalDrawTemplateOnTile) {
    originalDrawTemplateOnTile = templateManager.drawTemplateOnTile.bind(templateManager);

    templateManager.drawTemplateOnTile = async function(tileBlob, tileCoords) {
      const cacheKey = generateCacheKey(tileCoords, this.templatesArray, tileBlob);

      if (!tileRefreshPaused && smartTileCacheEnabled) {
        const cachedResult = getFromSmartCache(cacheKey);
        if (cachedResult) {
          return cachedResult;
        }
      }

      const result = await originalDrawTemplateOnTile(tileBlob, tileCoords);

      if (!tileRefreshPaused && !isCapturingState && smartTileCacheEnabled) {
        storeInSmartCache(cacheKey, result);

        const tileKey = Array.isArray(tileCoords) ?
          tileCoords[0].toString().padStart(4, '0') + ',' + tileCoords[1].toString().padStart(4, '0') :
          tileCoords.toString();
        frozenTileCache.set(tileKey, result);

        if (frozenTileCache.size > 100) {
          const firstKey = frozenTileCache.keys().next().value;
          frozenTileCache.delete(firstKey);
        }
      }

      return result;
    };
  }

  applyTileRefreshPause(templateManager);

  debugLog('[Tile Manager] Initialized with cache and pause functionality. Paused:', tileRefreshPaused);
}

/** Applies the tile refresh pause setting to the template manager
 * @param {Object} templateManager - The template manager instance
 * @since 0.91.0
 */
function applyTileRefreshPause(templateManager) {
  if (tileRefreshPaused) {
    templateManager.drawTemplateOnTile = function(tileBlob, tileCoords) {
      const tileKey = Array.isArray(tileCoords) ?
        tileCoords[0].toString().padStart(4, '0') + ',' + tileCoords[1].toString().padStart(4, '0') :
        tileCoords.toString();

      if (frozenTileCache.has(tileKey)) {
        debugLog('🧊 [Tile Refresh Paused] Using frozen tile cache for:', tileKey);
        return frozenTileCache.get(tileKey);
      }

      debugLog('⏸️ [Tile Refresh Paused] No cache for tile:', tileKey, '- returning original');
      return tileBlob;
    };
  } else {
    if (originalDrawTemplateOnTile) {
      templateManager.drawTemplateOnTile = async function(tileBlob, tileCoords) {
        const cacheKey = generateCacheKey(tileCoords, this.templatesArray, tileBlob);

        if (smartTileCacheEnabled) {
          const cachedResult = getFromSmartCache(cacheKey);
          if (cachedResult) {
            return cachedResult;
          }
        }

        const result = await originalDrawTemplateOnTile(tileBlob, tileCoords);

        if (!tileRefreshPaused && !isCapturingState && smartTileCacheEnabled) {
          storeInSmartCache(cacheKey, result);

          const tileKey = Array.isArray(tileCoords) ?
            tileCoords[0].toString().padStart(4, '0') + ',' + tileCoords[1].toString().padStart(4, '0') :
            tileCoords.toString();
          frozenTileCache.set(tileKey, result);

          if (frozenTileCache.size > 100) {
            const firstKey = frozenTileCache.keys().next().value;
            frozenTileCache.delete(firstKey);
          }
        }

        return result;
      };
    }
  }
}

/** Toggles the tile refresh pause state
 * @param {Object} templateManager - The template manager instance
 * @returns {boolean} The new pause state
 * @since 0.91.0
 */
export function toggleTileRefreshPause(templateManager) {
  if (!tileRefreshPaused) {
    debugLog('🧊 [Freeze Tiles] Freezing current template view with cached tiles');
  } else {
    debugLog('▶️ [Resume Tiles] Resuming live tile processing');
  }

  tileRefreshPaused = !tileRefreshPaused;
  saveTileRefreshPaused(tileRefreshPaused);
  applyTileRefreshPause(templateManager);

  debugLog('⏸️ Tile refresh pause toggled. Now paused:', tileRefreshPaused);

  return tileRefreshPaused;
}

/** Gets the current tile refresh pause state
 * @returns {boolean} Whether tile refresh is currently paused
 * @since 0.91.0
 */
export function isTileRefreshPaused() {
  return tileRefreshPaused;
}

/** Gets the number of tiles currently in the frozen cache
 * @returns {number} Number of cached tiles
 * @since 0.91.0
 */
export function getCachedTileCount() {
  return frozenTileCache.size;
}
