import Overlay from "./Overlay";

const SUPABASE_URL  = 'https://yxxqmabcrffoqegdtfpr.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl4eHFtYWJjcmZmb3FlZ2R0ZnByIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEzNDQ3NzcsImV4cCI6MjA3NjkyMDc3N30.0L8en_UyCCyDsqrQ6Ympt5ZsPDv3DujmYmaCbsZ5b0Y';
const TABLE         = 'leaderboard';
const REFRESH_MS    = 5 * 60 * 1000; // 5 minutes

/** Leaderboard window — tracks pixels painted per day/week/month
 *  via Supabase. Every user of this mod contributes their own row.
 * @class WindowLeaderboard
 * @since 0.88.600
 */
export default class WindowLeaderboard extends Overlay {

  constructor(executor) {
    super(executor.name, executor.version);
    this.window       = null;
    this.windowID     = 'bm-window-leaderboard';
    this.windowParent = document.body;

    this.windowStats  = executor.windowStats;
    this.apiManager   = executor.apiManager;

    this._tab         = 'day';
    this._rows        = [];
    this._intervalID  = null;
    this._myID        = null;
    this._myName      = null;
  }

  // ─── Date helpers ─────────────────────────────────────────────────────────

  #today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  #thisWeek() {
    const d    = new Date();
    const jan4 = new Date(d.getFullYear(), 0, 4);
    const week = Math.ceil(((d - jan4) / 86400000 + jan4.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${String(week).padStart(2,'0')}`;
  }

  #thisMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  }

  // ─── Supabase helpers ─────────────────────────────────────────────────────

  async #sbFetch(path, options = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        'apikey':        SUPABASE_ANON,
        'Authorization': `Bearer ${SUPABASE_ANON}`,
        'Content-Type':  'application/json',
        'Prefer':        options.prefer ?? '',
        ...(options.headers ?? {})
      }
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  }

  /** Upserts this user's row, then fetches all rows for rendering */
  async #sync() {
    // Resolve identity from apiManager (populated when /me is received)
    this._myID   = this.apiManager?.myID   ?? null;
    this._myName = this.apiManager?.myName ?? 'Player';

    // Upsert own row only if logged in
    if (this._myID) {
      const stats = this.windowStats?.stats;
      const todayPx = stats?.hourly?.reduce((a,b) => a+b, 0) ?? 0;
      const weekPx  = stats?.weekTotal  ?? 0;
      const monthPx = stats?.monthTotal ?? 0;

      // Fetch existing row to check periods
      const existing = await this.#sbFetch(
        `${TABLE}?select=px_day,px_week,px_month,day_period,week_period,month_period&user_id=eq.${String(this._myID)}`
      ).catch(() => null);

      const existingRow = existing?.[0];
      const currentDay = this.#today();
      const currentWeek = this.#thisWeek();
      const currentMonth = this.#thisMonth();

      // Determine pixel counts - reset to current if period changed, otherwise keep existing + current
      let finalDayPx = todayPx;
      let finalWeekPx = weekPx;
      let finalMonthPx = monthPx;

      if (existingRow) {
        // If same day, keep the maximum (prevents reset after script reinstall)
        if (existingRow.day_period === currentDay) {
          finalDayPx = Math.max(todayPx, existingRow.px_day || 0);
        }
        // If same week, keep the maximum
        if (existingRow.week_period === currentWeek) {
          finalWeekPx = Math.max(weekPx, existingRow.px_week || 0);
        } else {
          // New week - start fresh with current week stats
          finalWeekPx = weekPx;
        }
        // If same month, keep the maximum
        if (existingRow.month_period === currentMonth) {
          finalMonthPx = Math.max(monthPx, existingRow.px_month || 0);
        } else {
          // New month - start fresh with current month stats
          finalMonthPx = monthPx;
        }
      } else {
        // No existing row - this is first time, use current stats
        finalDayPx = todayPx;
        finalWeekPx = weekPx;
        finalMonthPx = monthPx;
      }

      // Upsert own row — build JSON as string to prevent minifier renaming keys
      const upsertBody = '{'
        + '"user_id":'      + JSON.stringify(String(this._myID))  + ','
        + '"username":'     + JSON.stringify(String(this._myName)) + ','
        + '"px_day":'       + finalDayPx  + ','
        + '"px_week":'      + finalWeekPx   + ','
        + '"px_month":'     + finalMonthPx  + ','
        + '"day_period":'   + JSON.stringify(currentDay)       + ','
        + '"week_period":'  + JSON.stringify(currentWeek)    + ','
        + '"month_period":' + JSON.stringify(currentMonth)
        + '}';
      await this.#sbFetch(`${TABLE}?on_conflict=user_id`, {
        method:  'POST',
        prefer:  'resolution=merge-duplicates',
        headers: { 'Prefer': 'resolution=merge-duplicates' },
        body:    '[' + upsertBody + ']'
      }).catch(e => console.error('LB upsert error:', e));
    }

    // Fetch all rows, ordered by current tab (always fetch, even if not logged in)
    const col   = this._tab === 'day' ? 'px_day' : this._tab === 'week' ? 'px_week' : 'px_month';
    const rows  = await this.#sbFetch(
      `${TABLE}?select=user_id,username,px_day,px_week,px_month,day_period,week_period,month_period&order=${col}.desc&limit=200`
    ).catch(() => null);

    if (rows) this._rows = rows;
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  #render() {
    const container = document.querySelector(`#${this.windowID} .bm-lb-list`);
    if (!container) return;

    const tab     = this._tab;
    const today   = this.#today();
    const week    = this.#thisWeek();
    const month   = this.#thisMonth();
    const pxField = tab === 'day' ? 'px_day' : tab === 'week' ? 'px_week' : 'px_month';
    const perField = tab === 'day' ? 'day_period' : tab === 'week' ? 'week_period' : 'month_period';
    const curPeriod = tab === 'day' ? today : tab === 'week' ? week : month;

    // Filter to current period only, re-sort
    const filtered = this._rows
      .filter(r => r[perField] === curPeriod && r[pxField] > 0)
      .sort((a, b) => b[pxField] - a[pxField]);

    // Get my current pixel count from stats
    const myPx = (tab === 'day' ? this.windowStats?.stats?.hourly?.reduce((a,b)=>a+b,0) :
                  tab === 'week' ? this.windowStats?.stats?.weekTotal :
                  this.windowStats?.stats?.monthTotal) ?? 0;

    // Find my position in the filtered leaderboard
    const myIdx = filtered.findIndex(r => String(r.user_id) === String(this._myID));
    let myRank = null;

    if (myIdx >= 0) {
      // Found in leaderboard - use actual position
      myRank = myIdx + 1;
    } else if (myPx > 0 && this._myID) {
      // Not in leaderboard but have pixels - calculate rank based on pixel count
      myRank = filtered.filter(r => r[pxField] > myPx).length + 1;
    } else if (this._myID) {
      // Logged in but no pixels yet - rank is after all players with pixels
      myRank = filtered.length + 1;
    }

    const top99  = filtered.slice(0, 99);
    const medals = ['🥇','🥈','🥉'];

    container.innerHTML = '';

    if (top99.length === 0) {
      const msg = document.createElement('small');
      msg.style.cssText = 'color:lightgray; padding:0.5em 0; display:block;';
      msg.textContent = 'No data for this period yet. Place some pixels!';
      container.appendChild(msg);
    }

    top99.forEach((row, i) => {
      const rank = i + 1;
      const isMe = String(row.user_id) === String(this._myID);
      const el   = document.createElement('div');
      el.style.cssText = [
        'display:flex; align-items:center; gap:0.5ch;',
        'padding:0.2em 0.4em; border-radius:3px; font-size:small;',
        'border-bottom:1px solid rgba(255,255,255,0.05);',
        isMe ? 'background:rgba(100,180,255,0.15); font-weight:700;' : ''
      ].join('');
      el.innerHTML = [
        `<span style="width:2.5ch;text-align:right;opacity:0.6;flex-shrink:0">${medals[i] ?? rank}</span>`,
        `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.#esc(row.username)}${isMe ? ' ◀' : ''}</span>`,
        `<span style="opacity:0.85;flex-shrink:0">${Number(row[pxField]).toLocaleString()} px</span>`
      ].join('');
      container.appendChild(el);
    });

    // Slot 100 — always the current user
    const mySlot = document.createElement('div');
    mySlot.style.cssText = [
      'display:flex; align-items:center; gap:0.5ch;',
      'padding:0.2em 0.4em; border-radius:3px; font-size:small; font-weight:700;',
      'background:rgba(255,210,0,0.12); border-top:1px solid rgba(255,210,0,0.3); margin-top:3px;'
    ].join('');
    const label = myRank
    mySlot.innerHTML = [
      `<span style="width:2.5ch;text-align:right;opacity:0.7;flex-shrink:0">${label}</span>`,
      `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.#esc(this._myName ?? 'You')} ◀ you</span>`,
      `<span style="opacity:0.85;flex-shrink:0">${Number(myPx).toLocaleString()} px</span>`
    ].join('');
    container.appendChild(mySlot);

    const ts = document.querySelector(`#${this.windowID} .bm-lb-ts`);
    if (ts) ts.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
  }

  #esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  async refresh() {
    const list = document.querySelector(`#${this.windowID} .bm-lb-list`);
    if (list) list.innerHTML = '<small style="color:lightgray;padding:0.3em 0;display:block">Loading...</small>';
    await this.#sync();
    this.#render();
  }

  #activateTab(tab, btns) {
    this._tab = tab;
    btns.forEach(b => {
      b.style.background    = b.dataset.tab === tab ? '#1061e5' : '#0e3a8a';
      b.style.fontWeight    = b.dataset.tab === tab ? '700' : '';
    });
    this.#render();
  }

  // ─── Build ────────────────────────────────────────────────────────────────

  buildWindow() {
    // Toggle: if already open, close it
    const existing = document.querySelector(`#${this.windowID}`);
    if (existing) {
      existing.remove();
      if (this._intervalID) { clearInterval(this._intervalID); this._intervalID = null; }
      return;
    }

    this.window = this.addDiv({
      'id': this.windowID,
      'class': 'bm-window bm-windowed',
      'style': 'top: 10px; left: unset; right: 385px; width: 280px;'
    })
      .addDragbar()
        .addButton({
          'class': 'bm-button-circle', 'textContent': '▼',
          'aria-label': 'Minimize Leaderboard', 'data-button-status': 'expanded'
        }, (instance, button) => {
          button.onclick    = () => instance.handleMinimization(button);
          button.ontouchend = () => { button.click(); };
        }).buildElement()
        .addDiv().buildElement()
      .buildElement()
      .addDiv({'class': 'bm-window-content'})

        .addDiv({'class': 'bm-container'})
          .addHeader(1, {'textContent': '🏆 Leaderboard'}).buildElement()
        .buildElement()
        .addHr().buildElement()

        // ── Tab bar ────────────────────────────────────────────────────────
        .addDiv({'class': 'bm-container', 'style': 'display:flex; gap:0.3ch; margin-bottom:0;'}, (instance, div) => {
          const tabDefs = [['day','Day'],['week','Week'],['month','Month']];
          const btns = [];
          tabDefs.forEach(([key, label]) => {
            const btn = document.createElement('button');
            btn.textContent   = label;
            btn.dataset.tab   = key;
            btn.style.cssText = 'flex:1; font-size:small; padding:0 0.3ch; border-radius:1em;';
            btn.style.background = key === 'day' ? '#1061e5' : '#0e3a8a';
            btn.onclick = () => this.#activateTab(key, btns);
            btns.push(btn);
            div.appendChild(btn);
          });
        }).buildElement()

        // ── List ───────────────────────────────────────────────────────────
        .addDiv({
          'class': 'bm-container bm-scrollable bm-lb-list',
          'style': 'max-height:300px; padding:0; margin-top:0.3em;'
        }, (instance, div) => {
          div.innerHTML = '<small style="color:lightgray">Loading...</small>';
        }).buildElement()

        // ── Footer ─────────────────────────────────────────────────────────
        .addDiv({'class': 'bm-container bm-flex-between', 'style': 'margin-bottom:0;'})
          .addSmall({'class': 'bm-lb-ts', 'textContent': '—'}).buildElement()
          .addButton({'textContent': '↻ Refresh', 'style': 'font-size:x-small;'}, (instance, button) => {
            button.onclick = async () => {
              button.disabled = true;
              await this.refresh();
              button.disabled = false;
            };
          }).buildElement()
        .buildElement()

      .buildElement()
    .buildElement().buildOverlay(this.windowParent);

    this.handleDrag(`#${this.windowID}.bm-window`, `#${this.windowID} .bm-dragbar`);

    // Initial load
    this.refresh();
    // Auto-refresh every 5 min
    this._intervalID = setInterval(() => this.refresh(), REFRESH_MS);
  }
}