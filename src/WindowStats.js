import Overlay from "./Overlay";

/** The overlay builder for the Pixel Statistics window.
 * @description Shows pixels placed this session and an hourly chart (resets at midnight).
 * @class WindowStats
 * @since 0.88.500
 * @see {@link Overlay} for examples
 */
export default class WindowStats extends Overlay {

  /** Constructor for the stats window
   * @param {*} executor - The executing class (WindowMain)
   * @since 0.88.500
   */
  constructor(executor) {
    super(executor.name, executor.version);
    this.window = null;
    this.windowID = 'bm-window-stats';
    this.windowParent = document.body;

    this.storageKey = 'bmPixelStats';

    /** @type {{date: string, hourly: number[], sessionCount: number}} */
    this.stats = this.#loadStats();

    // Schedule midnight reset
    this.#scheduleMidnightReset();
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /** Returns today's date as "YYYY-MM-DD" */
  #today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  /** Loads stats from GM storage; resets hourly array if the stored date differs from today. */
  #loadStats() {
    let data;
    try {
      data = JSON.parse(GM_getValue(this.storageKey, 'null'));
    } catch {
      data = null;
    }

    const today = this.#today();

    if (!data || data.date !== today) {
      // New day → fresh hourly array, keep nothing from yesterday
      return { date: today, hourly: new Array(24).fill(0), sessionCount: 0 };
    }

    // Ensure arrays are the right length (safety)
    if (!Array.isArray(data.hourly) || data.hourly.length !== 24) {
      data.hourly = new Array(24).fill(0);
    }

    data.sessionCount = data.sessionCount ?? 0;
    return data;
  }

  /** Saves current stats to GM storage. */
  async #saveStats() {
    await GM.setValue(this.storageKey, JSON.stringify(this.stats));
  }

  /** Sets a timeout that fires at the next midnight and resets the stats. */
  async #scheduleMidnightReset() {
    const now = new Date();
    const msToMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
    setTimeout(async () => {
      this.stats = { date: this.#today(), hourly: new Array(24).fill(0), sessionCount: 0 };
      await this.#saveStats();
      this.#renderChart();
      this.#renderCounters();
      this.#scheduleMidnightReset(); // schedule next day
    }, msToMidnight);
  }

  // ─── Chart rendering ──────────────────────────────────────────────────────────

  /** Draws the 24-hour line chart on the canvas element. */
  #renderChart() {
    const canvas = document.querySelector(`#${this.windowID} .bm-stats-canvas`);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;

    const PAD = { top: 10, right: 12, bottom: 28, left: 36 };
    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top - PAD.bottom;

    ctx.clearRect(0, 0, W, H);

    const data  = this.stats.hourly;
    const maxVal = Math.max(...data, 1); // avoid division by zero
    const currentHour = new Date().getHours();

    // ── Background ────────────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, 6);
    ctx.fill();

    // ── Grid lines ────────────────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    const gridLines = 4;
    for (let i = 0; i <= gridLines; i++) {
      const y = PAD.top + (chartH / gridLines) * i;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + chartW, y);
      ctx.stroke();

      // Y-axis labels
      const val = Math.round(maxVal * (1 - i / gridLines));
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(val, PAD.left - 3, y + 3);
    }

    // ── X-axis hour labels (every 3 hrs) ─────────────────────────────────────
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    for (let h = 0; h < 24; h += 3) {
      const x = PAD.left + (h / 23) * chartW;
      ctx.fillText(String(h), x, H - PAD.bottom + 12);
    }

    // ── Highlight current-hour column ─────────────────────────────────────────
    const colW = chartW / 23;
    const hx = PAD.left + (currentHour / 23) * chartW - colW / 2;
    ctx.fillStyle = 'rgba(100,180,255,0.07)';
    ctx.fillRect(hx, PAD.top, colW, chartH);

    // ── Area under the line ───────────────────────────────────────────────────
    const xOf = (i) => PAD.left + (i / 23) * chartW;
    const yOf = (v) => PAD.top + chartH - (v / maxVal) * chartH;

    const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + chartH);
    grad.addColorStop(0,   'rgba(255,210,0,0.35)');
    grad.addColorStop(1,   'rgba(255,210,0,0.02)');

    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(data[0]));
    for (let i = 1; i < 24; i++) ctx.lineTo(xOf(i), yOf(data[i]));
    ctx.lineTo(xOf(23), PAD.top + chartH);
    ctx.lineTo(xOf(0),  PAD.top + chartH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // ── Line ─────────────────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(data[0]));
    for (let i = 1; i < 24; i++) ctx.lineTo(xOf(i), yOf(data[i]));
    ctx.strokeStyle = '#ffd200';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // ── Data point dots ───────────────────────────────────────────────────────
    for (let i = 0; i <= currentHour; i++) {
      const x = xOf(i);
      const y = yOf(data[i]);
      ctx.beginPath();
      ctx.arc(x, y, i === currentHour ? 3.5 : 2, 0, Math.PI * 2);
      ctx.fillStyle = i === currentHour ? '#fff' : '#ffd200';
      ctx.fill();
    }

    // ── X-axis label ─────────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('hour of day', PAD.left + chartW / 2, H - 2);
  }

  /** Updates the session/today counters in the window. */
  #renderCounters() {
    const todayTotal = this.stats.hourly.reduce((a, b) => a + b, 0);

    const elSession = document.querySelector(`#${this.windowID} .bm-stats-session`);
    const elToday   = document.querySelector(`#${this.windowID} .bm-stats-today`);
    const elPeak    = document.querySelector(`#${this.windowID} .bm-stats-peak`);

    if (elSession) elSession.textContent = `Session: ${this.stats.sessionCount.toLocaleString()} px`;
    if (elToday)   elToday.textContent   = `Today:   ${todayTotal.toLocaleString()} px`;

    const peakHour  = this.stats.hourly.indexOf(Math.max(...this.stats.hourly));
    const peakVal   = this.stats.hourly[peakHour];
    if (elPeak) elPeak.textContent = peakVal > 0
      ? `Peak:    ${peakVal.toLocaleString()} px @ ${String(peakHour).padStart(2,'0')}:00`
      : 'Peak:    —';
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /** Called by the main pixel-tracking logic every time a pixel is successfully placed.
   *  You must call this from apiManager or main.js after a confirmed POST to /api/pixel/...
   */
  async recordPixel(count = 1) {
    const hour = new Date().getHours();
    this.stats.hourly[hour] += count;
    this.stats.sessionCount += count;
    this.stats.date = this.#today();
    await this.#saveStats();
    this.#renderChart();
    this.#renderCounters();
  }

  /** Builds and mounts the stats window. */
  buildWindow() {
    // Bring existing window to focus instead of creating a duplicate
    const existing = document.querySelector(`#${this.windowID}`);
    if (existing) {
      existing.parentElement.appendChild(existing);
      this.#renderChart();
      this.#renderCounters();
      return;
    }

    // Canvas dimensions (will be set via HTML attributes)
    const CANVAS_W = 262;
    const CANVAS_H = 110;

    this.window = this.addDiv({
      'id': this.windowID,
      'class': 'bm-window bm-windowed',
      'style': 'top: 10px; left: unset; right: 385px;'
    })
      .addDragbar()
        .addButton({
          'class': 'bm-button-circle',
          'textContent': '▼',
          'aria-label': 'Minimize Stats window',
          'data-button-status': 'expanded'
        }, (instance, button) => {
          button.onclick = () => instance.handleMinimization(button);
          button.ontouchend = () => { button.click(); };
        }).buildElement()
        .addDiv().buildElement()
      .buildElement()
      .addDiv({'class': 'bm-window-content'})

        // ── Title ─────────────────────────────────────────────────────────────
        .addDiv({'class': 'bm-container'})
          .addHeader(1, {'textContent': '📊 Pixel Stats'}).buildElement()
        .buildElement()
        .addHr().buildElement()

        // ── Counters ──────────────────────────────────────────────────────────
        .addDiv({'class': 'bm-container', 'style': 'font-size: small; line-height: 1.6;'})
          .addSpan({'class': 'bm-stats-session', 'style': 'display:block;', 'textContent': 'Session: 0 px'}).buildElement()
          .addSpan({'class': 'bm-stats-today',   'style': 'display:block;', 'textContent': 'Today:   0 px'}).buildElement()
          .addSpan({'class': 'bm-stats-peak',    'style': 'display:block;', 'textContent': 'Peak:    —'}).buildElement()
        .buildElement()

        // ── Chart ─────────────────────────────────────────────────────────────
        .addDiv({'class': 'bm-container', 'style': 'margin-top: 0.5em;'}, (instance, div) => {
          const canvas = document.createElement('canvas');
          canvas.className = 'bm-stats-canvas';
          canvas.width  = CANVAS_W;
          canvas.height = CANVAS_H;
          canvas.style.cssText = 'display:block; border-radius:4px; width:100%;';
          div.appendChild(canvas);
        }).buildElement()

        // ── Reset button ──────────────────────────────────────────────────────
        .addDiv({'class': 'bm-container bm-flex-between', 'style': 'margin-bottom: 0;'})
          .addSmall({'textContent': 'Resets daily at midnight'}).buildElement()
          .addButton({'textContent': 'Reset', 'style': 'font-size: x-small;'}, (instance, button) => {
            button.onclick = async () => {
              if (!confirm('Reset all pixel statistics?')) return;
              this.stats = { date: this.#today(), hourly: new Array(24).fill(0), sessionCount: 0 };
              await this.#saveStats();
              this.#renderChart();
              this.#renderCounters();
              instance.handleDisplayStatus('Stats reset!');
            };
          }).buildElement()
        .buildElement()

      .buildElement()
    .buildElement().buildOverlay(this.windowParent);

    this.handleDrag(`#${this.windowID}.bm-window`, `#${this.windowID} .bm-dragbar`);
    this.#renderChart();
    this.#renderCounters();
  }
}