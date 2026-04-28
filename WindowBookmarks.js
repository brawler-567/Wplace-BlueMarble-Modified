import Overlay from "./Overlay";

/** The overlay builder for the Bookmarks (saved positions) window.
 * @description Allows users to save canvas locations by name and teleport to them.
 * @class WindowBookmarks
 * @since 0.88.500
 * @see {@link Overlay} for examples
 */
export default class WindowBookmarks extends Overlay {

  /** Constructor for the bookmarks window
   * @param {*} executor - The executing class (WindowMain)
   * @since 0.88.500
   */
  constructor(executor) {
    super(executor.name, executor.version);
    this.window = null;
    this.windowID = 'bm-window-bookmarks';
    this.windowParent = document.body;

    /** Reference to apiManager for getting current coords @type {ApiManager} */
    this.apiManager = executor.apiManager;

    /** Storage key for GM_getValue/GM_setValue */
    this.storageKey = 'bmBookmarks';

    /** Loaded bookmarks array @type {Array<{name:string, lat:number, lng:number, zoom:number}>} */
    this.bookmarks = this.#loadBookmarks();
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /** Loads bookmarks from GM storage.
   * @returns {Array}
   */
  #loadBookmarks() {
    try {
      return JSON.parse(GM_getValue(this.storageKey, '[]'));
    } catch {
      return [];
    }
  }

  /** Persists current bookmarks array to GM storage. */
  async #saveBookmarks() {
    await GM.setValue(this.storageKey, JSON.stringify(this.bookmarks));
  }

  /** Converts Wplace tile+pixel coords to approximate lat/lng.
   *  Wplace uses a Leaflet map — the URL params are the Leaflet map center.
   *  We read lat/lng/zoom directly from the current URL so we always save
   *  exactly what the user is looking at, not a computed approximation.
   * @returns {{lat: number, lng: number, zoom: number} | null}
   */
  #getCurrentMapState() {
    try {
      const url = new URL(window.location.href);
      const lat  = parseFloat(url.searchParams.get('lat'));
      const lng  = parseFloat(url.searchParams.get('lng'));
      const zoom = parseFloat(url.searchParams.get('zoom'));
      if (isNaN(lat) || isNaN(lng) || isNaN(zoom)) return null;
      return { lat, lng, zoom };
    } catch {
      return null;
    }
  }

  /** Navigates the Wplace map to the given lat/lng/zoom.
   * @param {number} lat
   * @param {number} lng
   * @param {number} zoom
   */
  #teleport(lat, lng, zoom) {
    const url = new URL(window.location.href);
    url.searchParams.set('lat',  lat);
    url.searchParams.set('lng',  lng);
    url.searchParams.set('zoom', zoom);
    // Wplace reads lat/lng/zoom from the URL on page load.
    // Navigate directly — page reloads but the position is guaranteed correct.
    window.location.href = url.toString();
  }

  /** Re-renders the bookmark list inside the window. */
  #refreshList() {
    const list = document.querySelector(`#${this.windowID} .bm-bookmarks-list`);
    if (!list) return;

    list.innerHTML = '';

    if (this.bookmarks.length === 0) {
      const empty = document.createElement('small');
      empty.textContent = 'No saved positions yet.';
      empty.style.color = 'lightgray';
      list.appendChild(empty);
      return;
    }

    for (const [index, bm] of this.bookmarks.entries()) {
      const row = document.createElement('div');
      row.className = 'bm-container bm-flex-between bm-bookmark-row';
      row.style.cssText = 'margin: 0.25em 0; gap: 0.5ch;';

      // Name label
      const label = document.createElement('span');
      label.textContent = bm.name;
      label.title = `lat: ${bm.lat.toFixed(5)}, lng: ${bm.lng.toFixed(5)}, zoom: ${bm.zoom.toFixed(2)}`;
      label.style.cssText = 'flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: small; cursor: default;';

      // Teleport button
      const btnGo = document.createElement('button');
      btnGo.textContent = '→';
      btnGo.title = 'Teleport to this position';
      btnGo.className = 'bm-button-circle';
      btnGo.style.cssText = 'font-size: 1em; flex-shrink: 0;';
      btnGo.onclick = () => {
        this.#teleport(bm.lat, bm.lng, bm.zoom);
      };

      // Delete button
      const btnDel = document.createElement('button');
      btnDel.textContent = '✕';
      btnDel.title = 'Delete this bookmark';
      btnDel.className = 'bm-button-circle';
      btnDel.style.cssText = 'font-size: 0.8em; flex-shrink: 0;';
      btnDel.onclick = async () => {
        this.bookmarks.splice(index, 1);
        await this.#saveBookmarks();
        this.#refreshList();
      };

      row.appendChild(label);
      row.appendChild(btnGo);
      row.appendChild(btnDel);
      list.appendChild(row);
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /** Builds and mounts the bookmarks window. */
  buildWindow() {
    // Bring existing window to focus instead of creating a duplicate
    const existing = document.querySelector(`#${this.windowID}`);
    if (existing) {
      existing.parentElement.appendChild(existing);
      return;
    }

    this.window = this.addDiv({
      'id': this.windowID,
      'class': 'bm-window bm-windowed',
      'style': 'top: 10px; left: unset; right: 385px;'
    })
      .addDragbar()
        .addButton({
          'class': 'bm-button-circle',
          'textContent': '▼',
          'aria-label': 'Minimize Bookmarks window',
          'data-button-status': 'expanded'
        }, (instance, button) => {
          button.onclick = () => instance.handleMinimization(button);
          button.ontouchend = () => { button.click(); };
        }).buildElement()
        .addDiv().buildElement()
      .buildElement()
      .addDiv({'class': 'bm-window-content'})
        .addDiv({'class': 'bm-container'})
          .addHeader(1, {'textContent': '📍 Bookmarks'}).buildElement()
        .buildElement()
        .addHr().buildElement()

        // ── Save current position ─────────────────────────────────────────────
        .addDiv({'class': 'bm-container'})
          .addSpan({'textContent': 'Save current position:', 'style': 'font-size: small; display: block; margin-bottom: 0.25em;'}).buildElement()
          .addDiv({'class': 'bm-flex-between', 'style': 'gap: 0.5ch;'})
            .addInput({
              'type': 'text',
              'id': 'bm-bookmark-name-input',
              'placeholder': 'Location name...',
              'style': 'flex:1; background:rgba(0,0,0,0.2); color:white; border-radius:0.5em; padding:0 0.5ch; font-size:small; min-width:0;'
            }).buildElement()
            .addButton({'textContent': '＋ Save', 'style': 'white-space: nowrap; flex-shrink:0;'}, (instance, button) => {
              button.onclick = async () => {
                const nameInput = document.querySelector('#bm-bookmark-name-input');
                const name = nameInput?.value?.trim();

                if (!name) {
                  instance.handleDisplayError('Please enter a name for the bookmark!');
                  return;
                }

                const state = this.#getCurrentMapState();
                if (!state) {
                  instance.handleDisplayError('Could not read map position!\nTry moving the map first.');
                  return;
                }

                this.bookmarks.push({ name, ...state });
                await this.#saveBookmarks();
                nameInput.value = '';
                this.#refreshList();
                instance.handleDisplayStatus(`Saved: "${name}"`);
              };
            }).buildElement()
          .buildElement()
        .buildElement()

        .addHr().buildElement()

        // ── Bookmark list ─────────────────────────────────────────────────────
        .addDiv({
          'class': 'bm-container bm-scrollable bm-bookmarks-list',
          'style': 'max-height: 220px;'
        }).buildElement()

      .buildElement()
    .buildElement().buildOverlay(this.windowParent);

    this.handleDrag(`#${this.windowID}.bm-window`, `#${this.windowID} .bm-dragbar`);
    this.#refreshList();
  }
}