// Map view: a zoomable, pannable world map or globe with every layer the
// dashboard knows about, optional satellite imagery, hover highlighting with
// an info card, a layer picker sidebar, search and animations.
import { mix, strWidth, truncate, wrap } from '../term/ansi.mjs';
import { ATTR } from '../term/screen.mjs';
import { rect, splitH, splitV } from '../ui/layout.mjs';
import { pulse } from '../ui/fx.mjs';
import { ListView, button, hit, panel, segments } from '../ui/widgets.mjs';
import { DotCanvas } from '../map/canvas.mjs';
import { ImageryCache, IMAGERY, imageryById, latestDailyDate, nextImageryId } from '../map/imagery.mjs';
import { samplePixel } from '../map/png.mjs';
import { dayFactor, defaultView, destination, fmtCoord, haversineKm, makeProjector, normalizeView, panBy, subsolarPoint, wrapLon, zoomAt } from '../map/geo.mjs';
import { decodeWorld, renderGraticule, renderWorld, terminatorPoints, worldMask } from '../map/world.mjs';
import { LAYERS, LAYER_BY_ID, LAYER_GROUPS, buildFeatures, defaultLayerState, layerSources } from '../map/layers.mjs';
import { groundTrack, propagate } from '../map/orbit.mjs';

const SIDEBAR_W = 34;
const PAN_STEP = 8;

export class MapView {
  constructor(app) {
    this.app = app;
    this.id = 'map';
    this.label = 'Map';
    const saved = (app.prefs && app.prefs.map) || {};
    this.view = normalizeView({ ...defaultView(), ...(saved.view || {}) }, 320, 160);
    this.layers = { ...defaultLayerState(), ...(saved.layers || {}) };
    this.sat = Boolean(saved.sat);
    this.imagery = IMAGERY.some((i) => i.id === saved.imagery) ? saved.imagery : 'bluemarble';
    this.sidebar = saved.sidebar !== false;
    this.focus = 'map'; // 'map' | 'sidebar'
    this.sidebarList = new ListView();
    this.world = null;
    this.canvas = null;
    this.base = null;
    this.baseKey = '';
    this.hover = null; // { x, y } in cells, relative to the map rect
    this.hovered = null;
    this.pinned = null;
    this.drag = null;
    this.lastInteraction = app.now();
    this.rotate = true;
    this.search = null;
    this.features = [];
    this.counts = {};
    this.featureKey = '';
    this.dataVersion = 0;
    this.drawn = { points: [], lines: [], polys: [] };
    this.mapRect = rect(0, 0, 0, 0);
    this.imageryCache = new ImageryCache({ fetch: app.fetchImpl || ((...a) => globalThis.fetch(...a)), now: () => app.now(), onChange: () => app.markDirty() });
    this.imageryStatus = '';
    app.store.on('update', () => {
      this.dataVersion += 1;
    });
  }

  get store() {
    return this.app.store;
  }

  ensureWorld() {
    if (!this.world && this.app.catalog.world) this.world = decodeWorld(this.app.catalog.world);
    return this.world;
  }

  sources() {
    return ['fast', 'slow', ...layerSources(this.layers)];
  }

  mount() {
    this.syncWants(true);
  }

  unmount() {
    this.syncWants(false);
    this.persist();
  }

  syncWants(on) {
    for (const id of layerSources(this.layers)) if (this.store.sources[id]?.lazy) this.store.want(id, on);
  }

  persist() {
    if (!this.app.prefs) return;
    this.app.prefs.map = { view: this.view, layers: this.layers, sat: this.sat, imagery: this.imagery, sidebar: this.sidebar };
    this.app.savePrefs(this.app.prefs);
  }

  touch() {
    this.lastInteraction = this.app.now();
    this.app.markDirty();
  }

  hints() {
    if (this.search) return 'type to search · Enter jump · Esc close';
    if (this.focus === 'sidebar') return '↑↓ layers  Space toggle  ←/→ back to map  L again: map focus / hide';
    return '←→↑↓ pan  +/- zoom  g globe  s satellite  i imagery  L layers  / search  Enter details';
  }

  selectedUrl() {
    const f = this.pinned || this.hovered;
    return f && f.url ? f.url : null;
  }

  // --- state changes -----------------------------------------------------------

  setView(v) {
    this.view = normalizeView(v, this.canvas ? this.canvas.w : 320, this.canvas ? this.canvas.h : 160);
    this.touch();
  }

  toggleMode() {
    const mode = this.view.mode === 'globe' ? 'flat' : 'globe';
    const zoom = mode === 'globe' ? Math.max(0.9, Math.min(4, this.view.zoom / 2.2)) : Math.max(1, Math.min(60, this.view.zoom * 2.2));
    this.setView({ ...this.view, mode, zoom });
    this.app.toast(mode === 'globe' ? 'globe view' : 'flat map');
    this.persist();
  }

  toggleSat() {
    this.sat = !this.sat;
    this.app.toast(this.sat ? `satellite imagery: ${imageryById(this.imagery).label}` : 'satellite imagery off');
    this.touch();
    this.persist();
  }

  cycleImagery(step = 1) {
    this.imagery = nextImageryId(this.imagery, step);
    if (!this.sat) this.sat = true;
    this.app.toast(`imagery: ${imageryById(this.imagery).label}`);
    this.touch();
    this.persist();
  }

  toggleLayer(id, on) {
    const next = on === undefined ? !this.layers[id] : on;
    if (this.layers[id] === next) return;
    this.layers[id] = next;
    const src = LAYER_BY_ID.get(id)?.sources || [];
    for (const s of src) if (this.store.sources[s]?.lazy) this.store.want(s, next && layerSources(this.layers).includes(s));
    this.featureKey = '';
    this.baseKey = '';
    if (this.pinned && this.pinned.layer === id && !next) this.pinned = null;
    this.touch();
    this.persist();
  }

  setAllLayers(on) {
    for (const l of LAYERS) if (l.kind !== 'overlay') this.toggleLayer(l.id, on);
  }

  resetLayers() {
    const d = defaultLayerState();
    for (const l of LAYERS) this.toggleLayer(l.id, d[l.id]);
  }

  toggleGroup(groupId) {
    const members = LAYERS.filter((l) => l.group === groupId);
    const anyOff = members.some((l) => !this.layers[l.id]);
    for (const l of members) this.toggleLayer(l.id, anyOff);
  }

  pin(feature) {
    this.pinned = feature;
    this.touch();
  }

  centerOn(feature, minZoom = 6) {
    const zoom = this.view.mode === 'globe' ? Math.max(this.view.zoom, 2.5) : Math.max(this.view.zoom, minZoom);
    this.setView({ ...this.view, lon: feature.lon, lat: feature.lat, zoom });
  }

  openDetail(feature) {
    const f = feature || this.pinned || this.hovered;
    if (!f) return this.app.toast('hover or pin something on the map first', 1800, 'warn');
    const rows = [['Layer', f.layerLabel || f.layer], ['Position', fmtCoord(f.lat, f.lon)]];
    if (f.from && f.to) {
      rows.push(['From', `${f.fromName || fmtCoord(f.from[1], f.from[0])}`]);
      rows.push(['To', `${f.toName || fmtCoord(f.to[1], f.to[0])}`]);
      rows.push(['Length', `${Math.round(polylineKm(f.points)).toLocaleString('en-US')} km`]);
    }
    for (const [k, v] of f.info || []) rows.push([k, v]);
    this.app.openDetail({ title: f.name, subtitle: f.layerLabel || '', color: f.color, rows, url: f.url, onCenter: () => this.centerOn(f) });
  }

  // --- input ---------------------------------------------------------------------

  onKey(ev) {
    if (this.search) return this.onSearchKey(ev);
    const w = this.canvas ? this.canvas.w : 320;
    const h = this.canvas ? this.canvas.h : 160;
    const step = ev.shift ? PAN_STEP * 4 : PAN_STEP;
    if (this.focus === 'sidebar' && this.sidebar) {
      if (ev.name === 'left' || ev.name === 'h' || ev.name === 'right' || ev.name === 'l') {
        this.focus = 'map';
        this.touch();
        return true;
      }
      if (ev.name === 'enter' || ev.name === 'space') {
        const row = this.sidebarRows()[this.sidebarList.selected];
        if (row?.layer) this.toggleLayer(row.layer.id);
        else if (row?.group) this.toggleGroup(row.group.id);
        return true;
      }
      if (this.sidebarList.handleKey(ev)) {
        this.touch();
        return true;
      }
    }
    switch (ev.name) {
      case 'left':
      case 'h':
        this.setView(panBy(this.view, w, h, step, 0));
        return true;
      case 'right':
      case 'l':
        this.setView(panBy(this.view, w, h, -step, 0));
        return true;
      case 'up':
      case 'k':
        this.setView(panBy(this.view, w, h, 0, step));
        return true;
      case 'down':
      case 'j':
        this.setView(panBy(this.view, w, h, 0, -step));
        return true;
      case '+':
      case '=':
        this.setView(zoomAt(this.view, w, h, 1.5));
        return true;
      case '-':
      case '_':
        this.setView(zoomAt(this.view, w, h, 1 / 1.5));
        return true;
      case 'g':
        this.toggleMode();
        return true;
      case 's':
        this.toggleSat();
        return true;
      case 'i':
        this.cycleImagery(ev.shift ? -1 : 1);
        return true;
      case 'I':
        this.cycleImagery(-1);
        return true;
      case 'd':
        this.toggleLayer('dayNight');
        return true;
      case 'L':
        // Cycle: hidden → layers panel focused → map focused (panel stays) → hidden.
        if (!this.sidebar) {
          this.sidebar = true;
          this.focus = 'sidebar';
        } else if (this.focus === 'sidebar') this.focus = 'map';
        else {
          this.sidebar = false;
          this.focus = 'map';
        }
        this.touch();
        this.persist();
        return true;
      case '0':
        this.setView({ ...defaultView(), mode: this.view.mode, zoom: this.view.mode === 'globe' ? 1 : 1 });
        return true;
      case 'c':
      case 'escape':
        if (this.pinned || this.hovered) {
          this.pinned = null;
          this.hovered = null;
          this.touch();
          return true;
        }
        return false;
      case 'enter':
        this.openDetail();
        return true;
      case 'p':
        this.rotate = !this.rotate;
        this.app.toast(this.rotate ? 'globe auto-rotate on' : 'globe auto-rotate paused');
        return true;
      case '/':
        this.search = { query: '', results: [], index: 0 };
        this.touch();
        return true;
      case 'n':
      case 'N':
        return this.cycleSearch(ev.name === 'n' ? 1 : -1);
      default:
        return false;
    }
  }

  onSearchKey(ev) {
    const sch = this.search;
    if (ev.name === 'escape') {
      this.search = null;
    } else if (ev.name === 'enter') {
      const hitItem = sch.results[sch.index];
      this.lastResults = sch.results;
      this.lastIndex = sch.index;
      this.search = null;
      if (hitItem) this.jumpTo(hitItem);
    } else if (ev.name === 'backspace') {
      sch.query = sch.query.slice(0, -1);
      this.runSearch();
    } else if (ev.name === 'down' || (ev.ctrl && ev.name === 'n')) {
      sch.index = Math.min(sch.results.length - 1, sch.index + 1);
    } else if (ev.name === 'up' || (ev.ctrl && ev.name === 'p')) {
      sch.index = Math.max(0, sch.index - 1);
    } else if (ev.ch && !ev.ctrl && ev.ch.length === 1 && ev.name !== 'tab') {
      sch.query += ev.ch;
      this.runSearch();
    }
    this.touch();
    return true;
  }

  runSearch() {
    const q = this.search.query.trim().toLowerCase();
    this.search.index = 0;
    if (!q) {
      this.search.results = [];
      return;
    }
    const world = this.ensureWorld();
    const results = [];
    for (const f of this.features) {
      const n = String(f.name || '').toLowerCase();
      if (n.includes(q)) results.push({ score: n.startsWith(q) ? 0 : 1, label: f.name, sub: f.layerLabel, feature: f });
    }
    if (world) {
      for (const c of world.countries) {
        const n = String(c.name || '').toLowerCase();
        if (n.includes(q)) results.push({ score: n.startsWith(q) ? 0 : 2, label: c.name, sub: 'country', country: c });
      }
    }
    results.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
    this.search.results = results.slice(0, 40);
  }

  cycleSearch(dir) {
    if (!this.lastResults || !this.lastResults.length) return false;
    this.lastIndex = (this.lastIndex + dir + this.lastResults.length) % this.lastResults.length;
    this.jumpTo(this.lastResults[this.lastIndex]);
    return true;
  }

  jumpTo(item) {
    if (item.feature) {
      this.pin(item.feature);
      this.centerOn(item.feature);
    } else if (item.country) {
      const [lon, lat] = item.country.centroid;
      this.pinned = null;
      this.setView({ ...this.view, lon, lat, zoom: this.view.mode === 'globe' ? Math.max(this.view.zoom, 1.6) : Math.max(this.view.zoom, 4) });
    }
    this.app.toast(`→ ${item.label}`);
  }

  // Mouse events inside the map area; returns true when handled.
  onMouse(ev) {
    const r = this.mapRect;
    const inside = ev.x >= r.x && ev.y >= r.y && ev.x < r.x + r.w && ev.y < r.y + r.h;
    const w = this.canvas ? this.canvas.w : 320;
    const h = this.canvas ? this.canvas.h : 160;
    if (ev.kind === 'move') {
      if (!inside) {
        if (this.hover) {
          this.hover = null;
          this.hovered = null;
          this.app.markDirty();
        }
        return false;
      }
      this.hover = { x: ev.x - r.x, y: ev.y - r.y };
      const next = this.pick(this.hover.x, this.hover.y);
      if (next !== this.hovered) {
        this.hovered = next;
        this.app.markDirty();
      }
      this.lastInteraction = this.app.now();
      return true;
    }
    if (ev.kind === 'down' && ev.button === 0 && inside) {
      this.drag = { x: ev.x, y: ev.y, moved: false, view: this.view };
      this.focus = 'map';
      this.touch();
      return true;
    }
    if (ev.kind === 'drag' && this.drag) {
      const dx = (ev.x - this.drag.x) * 2;
      const dy = (ev.y - this.drag.y) * 4;
      if (Math.abs(dx) + Math.abs(dy) >= 2) this.drag.moved = true;
      if (this.drag.moved) this.setView(panBy(this.drag.view, w, h, dx, dy));
      return true;
    }
    if (ev.kind === 'up' && this.drag) {
      const d = this.drag;
      this.drag = null;
      if (!d.moved && inside) {
        this.hover = { x: ev.x - r.x, y: ev.y - r.y };
        const f = this.pick(this.hover.x, this.hover.y);
        const now = this.app.now();
        if (f && this.pinned === f && now - (this.lastClickAt || 0) < 500) this.openDetail(f);
        else if (f) this.pin(f);
        else if (this.pinned) this.pinned = null;
        this.lastClickAt = now;
        this.touch();
      } else this.persist();
      return true;
    }
    if ((ev.kind === 'wheelup' || ev.kind === 'wheeldown') && inside) {
      const factor = ev.kind === 'wheelup' ? 1.25 : 1 / 1.25;
      this.setView(zoomAt(this.view, w, h, factor, (ev.x - r.x) * 2 + 1, (ev.y - r.y) * 4 + 2));
      return true;
    }
    return false;
  }

  // Nearest drawn feature to a cell: points first, then lines, then polygons.
  pick(cx, cy) {
    const px = cx * 2 + 1;
    const py = cy * 4 + 2;
    let best = null;
    let bestD = 4.5;
    for (const p of this.drawn.points) {
      const d = Math.hypot(p.x - px, (p.y - py) / 1.2) - (p.f.size || 0) * 0.4;
      if (d < bestD) {
        bestD = d;
        best = p.f;
      }
    }
    if (best) return best;
    bestD = 3;
    for (const l of this.drawn.lines) {
      if (px < l.minX - 3 || px > l.maxX + 3 || py < l.minY - 3 || py > l.maxY + 3) continue;
      for (const [x0, y0, x1, y1] of l.segs) {
        const d = segDist(px, py, x0, y0, x1, y1);
        if (d < bestD) {
          bestD = d;
          best = l.f;
        }
      }
    }
    if (best) return best;
    for (const poly of this.drawn.polys) {
      if (poly.rings.some((ring) => pointInRing(px, py, ring))) return poly.f;
    }
    return this.countryAt(px, py);
  }

  countryAt(px, py) {
    const world = this.ensureWorld();
    if (!world || !this.proj) return null;
    const g = this.proj.fromDot(px, py);
    if (!g) return null;
    const v = worldMask(world).get(g.lon, g.lat);
    if (!v) return null;
    const c = world.countries[v - 1];
    if (!c) return null;
    const info = [];
    for (const l of LAYERS) {
      if (l.kind === 'choropleth' && this.layers[l.id] && l.countryInfo) {
        const rows = l.countryInfo(this.layerCtx())(c);
        if (rows) info.push(...rows);
      }
    }
    return { id: `country:${c.id}`, layer: 'country', layerLabel: 'country', name: c.name, lat: c.centroid[1], lon: c.centroid[0], glyph: '', color: this.app.theme.text, size: 0, info: [['ISO', c.a2 || '—'], ...info], country: c };
  }

  // --- data ----------------------------------------------------------------------

  layerCtx() {
    return { catalog: this.app.catalog, data: this.store.data, raw: this.store.raw, t: this.app.theme, now: this.app.now(), world: this.ensureWorld() };
  }

  refreshFeatures() {
    const enabled = Object.keys(this.layers).filter((k) => this.layers[k]).join(',');
    const key = `${this.dataVersion}|${enabled}|${this.app.theme.id}`;
    if (key === this.featureKey) return;
    this.featureKey = key;
    const { features, counts } = buildFeatures(this.layerCtx(), this.layers);
    this.features = features;
    this.counts = counts;
    if (this.pinned) this.pinned = features.find((f) => f.id === this.pinned.id) || (this.pinned.layer === 'country' ? this.pinned : null);
    if (this.hovered) this.hovered = features.find((f) => f.id === this.hovered.id) || (this.hovered.layer === 'country' ? this.hovered : null);
  }

  // --- rendering -----------------------------------------------------------------

  render(ctx, r) {
    const { s, t, now } = ctx;
    const world = this.ensureWorld();
    const showSidebar = this.sidebar && r.w >= 90;
    const [toolbarR, bodyR, footerR] = splitV(r, [1, 'fill', 1]);
    const [mapOuter, sideR] = showSidebar ? splitH(bodyR, ['fill', SIDEBAR_W]) : [bodyR, null];
    const inner = panel(ctx, mapOuter, {
      title: `${this.view.mode === 'globe' ? 'Globe' : 'World map'} · ${this.sat ? imageryById(this.imagery).short : 'tactical'}`,
      focused: this.focus === 'map',
      right: `${this.features.length} features · ${this.view.mode === 'globe' ? `×${this.view.zoom.toFixed(1)}` : `zoom ×${this.view.zoom < 10 ? this.view.zoom.toFixed(1) : Math.round(this.view.zoom)}`}`,
      badge: this.app.anim && this.view.mode === 'globe' && this.rotate && !this.pinned && now - this.lastInteraction > 4000 ? 'ROTATING' : null,
      badgeColor: t.accent3,
    });
    this.mapRect = inner;
    if (!world || inner.w < 10 || inner.h < 4) {
      s.text(inner.x + 1, inner.y + 1, 'terminal too small for the map', { fg: t.dim, bg: t.panel });
      return;
    }
    if (!this.canvas || this.canvas.cols !== inner.w || this.canvas.rows !== inner.h) {
      this.canvas = new DotCanvas(inner.w, inner.h);
      this.base = new DotCanvas(inner.w, inner.h);
      this.baseKey = '';
      this.view = normalizeView(this.view, this.canvas.w, this.canvas.h);
    }
    // Idle globe rotation.
    if (this.app.anim && this.view.mode === 'globe' && this.rotate && !this.pinned && !this.drag && now - this.lastInteraction > 4000) {
      this.view = normalizeView({ ...this.view, lon: this.view.lon + 0.12 }, this.canvas.w, this.canvas.h);
    }
    this.refreshFeatures();
    this.drawToolbar(ctx, toolbarR);
    this.drawMap(ctx, inner);
    if (showSidebar) this.drawSidebar(ctx, sideR);
    this.drawFooter(ctx, footerR);
    if (this.search) this.drawSearch(ctx, inner);
  }

  drawToolbar(ctx, r) {
    const { s, t } = ctx;
    s.fill(r, ' ', { bg: t.bg });
    let x = r.x + 1;
    const b = (text, opts) => {
      x += button(ctx, x, r.y, text, opts) + 1;
    };
    b(this.view.mode === 'globe' ? '◍ GLOBE' : '▭ FLAT', { active: true, activeBg: t.accent, onClick: () => this.toggleMode() });
    b(`SAT ${this.sat ? 'ON' : 'OFF'}`, { active: this.sat, activeBg: t.good, onClick: () => this.toggleSat() });
    b(imageryById(this.imagery).short, { active: false, fg: this.sat ? t.text : t.dim, onClick: () => this.cycleImagery() });
    b(`☾ ${this.layers.dayNight ? 'DAY/NIGHT' : 'NO SHADE'}`, { active: Boolean(this.layers.dayNight), activeBg: t.accent3, onClick: () => this.toggleLayer('dayNight') });
    b('−', { onClick: () => this.setView(zoomAt(this.view, this.canvas.w, this.canvas.h, 1 / 1.5)) });
    b('+', { onClick: () => this.setView(zoomAt(this.view, this.canvas.w, this.canvas.h, 1.5)) });
    b('⌂ RESET', { onClick: () => this.setView({ ...defaultView(), mode: this.view.mode }) });
    b('⌕ SEARCH', { active: Boolean(this.search), onClick: () => this.onKey({ name: '/' }) });
    const onCount = LAYERS.filter((l) => this.layers[l.id] && l.kind !== 'overlay').length;
    b(`☰ LAYERS ${onCount}`, { active: this.sidebar, activeBg: t.accent2, onClick: () => this.onKey({ name: 'L' }) });
    if (this.pinned) b(`✕ ${truncate(this.pinned.name, 18)}`, { active: true, activeBg: t.warn, onClick: () => { this.pinned = null; this.touch(); } });
    const right = [];
    if (this.sat) right.push({ text: this.imageryStatus, fg: t.dim });
    const c = this.view;
    right.push({ text: `  ${fmtCoord(c.lat, c.lon)} `, fg: t.text });
    const rx = r.x + r.w - 1 - right.reduce((a, seg) => a + strWidth(seg.text), 0);
    if (rx > x) segments(ctx, rx, r.y, right, r.x + r.w - rx, { bg: t.bg });
  }

  drawFooter(ctx, r) {
    const { s, t } = ctx;
    s.fill(r, ' ', { bg: t.bg });
    const segs = [];
    if (this.hover && this.proj) {
      const g = this.proj.fromDot(this.hover.x * 2 + 1, this.hover.y * 4 + 2);
      if (g) segs.push({ text: ` ◎ ${fmtCoord(g.lat, g.lon)} `, fg: t.accent });
    }
    const f = this.hovered || this.pinned;
    if (f) {
      segs.push({ text: `${f.glyph || '▸'} `, fg: f.color || t.text });
      segs.push({ text: `${f.name} `, fg: t.text, attr: ATTR.BOLD });
      segs.push({ text: `· ${f.layerLabel || f.layer} `, fg: t.dim });
      if (f.from && f.to) segs.push({ text: `· ${f.fromName || fmtCoord(f.from[1], f.from[0])} → ${f.toName || fmtCoord(f.to[1], f.to[0])} `, fg: t.dim });
    } else {
      segs.push({ text: ' hover anything to highlight its layer · click to pin · Enter for details · drag to pan · wheel to zoom', fg: t.dim });
    }
    if (this.sat) segs.push({ text: `  imagery ${imageryById(this.imagery).credit}`, fg: t.muted });
    segments(ctx, r.x, r.y, segs, r.w, { bg: t.bg });
  }

  drawSidebar(ctx, r) {
    const { s, t } = ctx;
    const focused = this.focus === 'sidebar';
    const inner = panel(ctx, r, { title: 'Layers', focused, onClick: () => { this.focus = 'sidebar'; this.touch(); } });
    if (inner.w < 10) return;
    let x = inner.x;
    x += button(ctx, x, inner.y, 'ALL', { onClick: () => this.setAllLayers(true) }) + 1;
    x += button(ctx, x, inner.y, 'NONE', { onClick: () => this.setAllLayers(false) }) + 1;
    x += button(ctx, x, inner.y, 'DEFAULT', { onClick: () => this.resetLayers() }) + 1;
    x += button(ctx, x, inner.y, 'HIDE', { onClick: () => this.onKey({ name: 'L' }) });
    const listR = rect(inner.x, inner.y + 1, inner.w, inner.h - 1);
    const rows = this.sidebarRows();
    this.sidebarList.draw(
      ctx,
      listR,
      rows,
      (row, _i, { width }) => {
        if (row.group) {
          const members = LAYERS.filter((l) => l.group === row.group.id);
          const on = members.filter((l) => this.layers[l.id]).length;
          return [
            { text: `${row.group.label.toUpperCase()} `, fg: t.title, attr: ATTR.BOLD },
            { text: `${on}/${members.length}`, fg: t.dim },
          ];
        }
        const l = row.layer;
        const on = Boolean(this.layers[l.id]);
        const count = this.counts[l.id];
        const countText = l.build ? (on ? String(count ?? 0) : '') : '';
        const color = t[l.color] || t.text;
        const focusLayer = (this.hovered || this.pinned)?.layer;
        const nameW = Math.max(4, width - 4 - 2 - countText.length - 1);
        return [
          { text: on ? '◼ ' : '◻ ', fg: on ? color : t.muted },
          { text: `${l.glyph || ' '} `, fg: on ? color : t.muted },
          { text: truncate(l.label, nameW).padEnd(nameW), fg: focusLayer === l.id ? t.selText : on ? t.text : t.dim, attr: focusLayer === l.id ? ATTR.BOLD : 0 },
          { text: ` ${countText}`, fg: t.dim },
        ];
      },
      {
        focused,
        onFocus: () => {
          this.focus = 'sidebar';
        },
        onSelect: (row) => {
          if (row.layer) this.toggleLayer(row.layer.id);
          else if (row.group) this.toggleGroup(row.group.id);
        },
        onActivate: (row) => {
          if (row.layer) this.toggleLayer(row.layer.id);
          else if (row.group) this.toggleGroup(row.group.id);
        },
      },
    );
    void s;
  }

  sidebarRows() {
    const rows = [];
    for (const g of LAYER_GROUPS) {
      rows.push({ group: g });
      for (const l of LAYERS) if (l.group === g.id) rows.push({ layer: l });
    }
    return rows;
  }

  drawSearch(ctx, inner) {
    const { s, t } = ctx;
    const sch = this.search;
    const w = Math.min(inner.w - 4, 60);
    const items = sch.results.slice(0, 10);
    const h = 3 + items.length;
    const box = rect(inner.x + 2, inner.y + 1, w, h);
    s.fill(box, ' ', { bg: t.sel });
    s.box(box, { fg: t.borderFocus, bg: t.sel }, 'round');
    s.text(box.x + 2, box.y, ' SEARCH ', { fg: t.title, bg: t.sel, attr: ATTR.BOLD });
    s.text(box.x + 2, box.y + 1, `⌕ ${sch.query}▏`, { fg: t.text, bg: t.sel, attr: ATTR.BOLD }, w - 4);
    items.forEach((it, i) => {
      const y = box.y + 2 + i;
      const active = i === sch.index;
      s.fill(rect(box.x + 1, y, w - 2, 1), ' ', { bg: active ? t.borderFocus : t.sel });
      s.text(box.x + 2, y, truncate(it.label, w - 20), { fg: active ? t.selText : t.text, bg: active ? t.borderFocus : t.sel });
      s.text(box.x + w - 2 - Math.min(14, strWidth(it.sub)), y, truncate(it.sub, 14), { fg: active ? t.selText : t.dim, bg: active ? t.borderFocus : t.sel });
      hit(ctx, rect(box.x, y, w, 1), { onClick: () => { this.search = null; this.jumpTo(it); } });
    });
    if (!items.length && sch.query) s.text(box.x + 2, box.y + 2, 'no matches', { fg: t.dim, bg: t.sel });
  }

  // --- the map itself ---------------------------------------------------------------

  drawMap(ctx, inner) {
    const { t, now } = ctx;
    const canvas = this.canvas;
    const proj = makeProjector(this.view, canvas.w, canvas.h);
    this.proj = proj;
    const world = this.world;
    const anim = this.app.anim;
    const sun = subsolarPoint(now);
    const night = Boolean(this.layers.dayNight);

    // Base: land fill, borders, graticule (cached per view).
    const choro = LAYERS.filter((l) => l.kind === 'choropleth' && this.layers[l.id]);
    const baseKey = [this.view.mode, this.view.lon.toFixed(3), this.view.lat.toFixed(3), this.view.zoom.toFixed(3), canvas.w, canvas.h, t.id, this.sat, this.layers.borders, this.layers.graticule, choro.map((c) => c.id).join(','), choro.length ? this.dataVersion : 0].join('|');
    if (baseKey !== this.baseKey) {
      this.baseKey = baseKey;
      this.base.clear();
      const colorFns = choro.map((l) => l.countryColor(this.layerCtx()));
      const land = this.sat ? null : mix(t.mapDim, t.map, 0.22);
      const zoomed = this.view.mode === 'globe' ? this.view.zoom >= 1.6 : this.view.zoom >= 2.2;
      const fillColor = (country) => {
        for (const fn of colorFns) {
          const c = fn(country);
          if (c) return this.sat ? c : mix(t.panel, c, 0.55);
        }
        return land;
      };
      if (this.layers.graticule) renderGraticule(this.base, proj, mix(t.panel, t.muted, 0.7));
      renderWorld(this.base, proj, world, {
        fill: !this.sat || choro.length > 0,
        fillColor,
        borders: Boolean(this.layers.borders),
        coast: this.sat ? mix(t.map, '#ffffff', 0.25) : t.map,
        border: zoomed ? (this.sat ? mix(t.mapDim, '#ffffff', 0.35) : mix(t.mapDim, t.map, 0.45)) : null,
        outline: this.view.mode === 'globe' ? t.border : null,
        pattern: this.sat ? 2 : 0,
      });
    }
    canvas.copyFrom(this.base);

    // Radar sweep (flat, tactical).
    if (anim && this.view.mode === 'flat' && !this.sat) {
      const sweepX = Math.floor(((now / 40) % (canvas.cols + 24)) - 12);
      for (let dx = -10; dx <= 1; dx++) {
        const cx = sweepX + dx;
        if (cx < 0 || cx >= canvas.cols) continue;
        const f = dx >= 0 ? 1 : 1 + dx / 10;
        for (let cy = 0; cy < canvas.rows; cy++) {
          const ci = cy * canvas.cols + cx;
          if (canvas.code[ci] && canvas.pri[ci] <= 2) canvas.color[ci] = mix(canvas.color[ci] || t.map, t.scan, 0.75 * f);
        }
      }
    }

    // Terminator line.
    if (night) {
      const pts = terminatorPoints(sun);
      let prev = null;
      for (const [lon, lat] of pts) {
        const [x, y, vis] = proj.toDot(lon, lat);
        if (prev && vis && prev[2] && Math.abs(x - prev[0]) < canvas.w / 2) canvas.line(prev[0], prev[1], x, y, mix(t.accent3, t.panel, 0.3), 3, 3, Math.floor(now / 120));
        prev = [x, y, vis];
      }
    }

    this.drawFeatures(ctx, canvas, proj);

    // Labels: country names when zoomed in.
    if (this.layers.labels && (this.view.zoom >= 2.2 || this.view.mode === 'globe')) {
      // Label the countries that are large enough for the current scale, biggest first.
      const scale = this.view.mode === 'globe' ? this.view.zoom * 2.5 : this.view.zoom;
      const minArea = scale >= 12 ? 0 : scale >= 6 ? 4 : scale >= 3.5 ? 25 : 90;
      let placed = 0;
      const candidates = world.countries.filter((c) => c.area >= minArea).sort((a, b) => b.area - a.area);
      for (const c of candidates) {
        if (placed > 50) break;
        const [lon, lat] = c.centroid;
        const [x, y, vis] = proj.toDot(lon, lat);
        if (!vis || x < 0 || y < 0 || x >= canvas.w || y >= canvas.h) continue;
        const name = scale < 6 ? c.name.toUpperCase().slice(0, 16) : c.name.toUpperCase();
        if (canvas.label(Math.floor(x / 2) - Math.floor(name.length / 2), Math.floor(y / 4), name, mix(t.panel, t.dim, 0.9), { pri: -1 })) placed++;
      }
    }

    // Composite: imagery background and night shading.
    const background = this.sat ? this.backgroundFn(proj, canvas, now, night ? sun : null) : null;
    const shade = night && !this.sat ? (cx, cy) => {
      const g = proj.fromDot(cx * 2 + 1, cy * 4 + 2);
      return g ? 0.55 + 0.45 * dayFactor(g.lat, g.lon, sun) : 1;
    } : null;
    canvas.blit(ctx, inner, { background, shade, nightColor: mix(t.panel, '#000000', 0.6) });

    // Hover / pin card.
    const f = this.pinned || this.hovered;
    if (f) this.drawCard(ctx, inner, f, Boolean(this.pinned));
    if (this.hover && this.app.anim && !this.drag) {
      // crosshair cursor
      const { s } = ctx;
      const cx = inner.x + this.hover.x;
      const cy = inner.y + this.hover.y;
      if (cx < inner.x + inner.w && cy < inner.y + inner.h) {
        const cell = s.cellAt ? s.cellAt(cx, cy) : null;
        if (cell && cell.ch === ' ') s.put(cx, cy, '┼', { fg: mix(t.accent, t.panel, 0.4), bg: cell.bg });
      }
    }
  }

  // Imagery sampler for the current frame: returns (cx, cy) -> { top, bottom } | null.
  backgroundFn(proj, _canvas, now, sun) {
    const t = this.app.theme;
    const layer = imageryById(this.imagery);
    const time = layer.daily ? latestDailyDate(now) : undefined;
    let req;
    let worldWide = false;
    if (this.view.mode === 'globe') {
      req = { layer: layer.gibs, bbox: [-180, -90, 180, 90], width: 1080, height: 540, time };
      worldWide = true;
    } else {
      const [west, south, east, north] = proj.bbox();
      const pxPerDeg = proj.k / 2;
      if (east - west >= 359.9 || west < -180 || east > 180) {
        req = { layer: layer.gibs, bbox: [-180, Math.max(-90, south), 180, Math.min(90, north)], width: Math.min(2048, Math.max(64, Math.round(360 * pxPerDeg))), height: Math.max(8, Math.round((Math.min(90, north) - Math.max(-90, south)) * pxPerDeg)), time };
        worldWide = true;
      } else {
        req = { layer: layer.gibs, bbox: [west, Math.max(-90, south), east, Math.min(90, north)], width: Math.max(8, Math.round((east - west) * pxPerDeg)), height: Math.max(8, Math.round((Math.min(90, north) - Math.max(-90, south)) * pxPerDeg)), time };
      }
    }
    const entry = this.imageryCache.get(req, this.view.mode === 'globe' ? 'globe' : 'view');
    let nightEntry = null;
    if (sun && layer.id !== 'night') nightEntry = this.imageryCache.get({ ...req, layer: 'VIIRS_Black_Marble', time: undefined }, 'night');
    const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[Math.floor(now / 80) % 10];
    this.imageryStatus = entry.status === 'ready' ? `${layer.short}${time ? ` ${time}` : ''}` : entry.status === 'error' ? `imagery error: ${entry.error}` : `${spin} loading imagery`;
    if (entry.status !== 'ready') {
      // Fall back to the previous ready image of the same slot if any (keeps the map from flashing).
      const prev = [...this.imageryCache.entries.values()].filter((e) => e.status === 'ready' && e.slot === entry.slot && e.req.layer === layer.gibs).sort((a, b) => b.at - a.at)[0];
      if (!prev) return () => ({ top: mix(t.panel, '#000000', 0.5), bottom: mix(t.panel, '#000000', 0.5) });
      return this.sampler(prev, proj, worldWide, now, sun, nightEntry, 1);
    }
    const fade = this.app.anim ? Math.min(1, (now - (entry.readyAt || now)) / 700) : 1;
    return this.sampler(entry, proj, worldWide, now, sun, nightEntry, fade);
  }

  sampler(entry, proj, worldWide, _now, sun, nightEntry, fade) {
    const t = this.app.theme;
    const img = entry.image;
    const [w, s, e, n] = entry.req.bbox;
    const dark = mix(t.panel, '#000000', 0.5);
    const nightImg = nightEntry && nightEntry.status === 'ready' ? nightEntry.image : null;
    const sampleAt = (lon, lat) => {
      if (lat < s || lat > n) return null;
      let u;
      if (worldWide) u = (wrapLon(lon) + 180) / 360;
      else {
        u = (lon - w) / (e - w);
        if (u < 0 || u > 1) {
          const lw = wrapLon(lon);
          u = (lw - w) / (e - w);
          if (u < 0 || u > 1) return null;
        }
      }
      const v = (n - lat) / (n - s);
      const px = samplePixel(img, u, v);
      if (!px) return null;
      let color = rgb(px);
      if (sun) {
        const f = dayFactor(lat, lon, sun);
        if (f < 1) {
          let nightColor = '#02040a';
          if (nightImg) {
            const np = samplePixel(nightImg, u, v);
            if (np) nightColor = rgb([Math.min(255, np[0] * 1.6 + 4), Math.min(255, np[1] * 1.5 + 6), Math.min(255, np[2] * 1.3 + 12)]);
          }
          color = mix(nightColor, color, 0.08 + 0.92 * f);
        }
      }
      return fade < 1 ? mix(t.panel, color, fade) : color;
    };
    return (cx, cy) => {
      const gTop = proj.fromDot(cx * 2 + 1, cy * 4 + 1);
      const gBot = proj.fromDot(cx * 2 + 1, cy * 4 + 3);
      if (!gTop && !gBot) return null;
      const top = gTop ? sampleAt(gTop.lon, gTop.lat) : null;
      const bottom = gBot ? sampleAt(gBot.lon, gBot.lat) : null;
      if (!top && !bottom) return null;
      return { top: top || dark, bottom: bottom || dark };
    };
  }

  drawFeatures(ctx, canvas, proj) {
    const { t, now } = ctx;
    const anim = this.app.anim;
    const focusF = this.pinned || this.hovered;
    const focusLayer = focusF && focusF.layer !== 'country' ? focusF.layer : null;
    const dimColor = mix(t.panel, t.dim, 0.7);
    const points = [];
    const lines = [];
    const polys = [];
    const projectPath = (pts) => {
      // Returns an array of screen paths (split at wrap / horizon).
      const paths = [];
      let cur = [];
      let prevLon = null;
      let acc = 0;
      for (const [lon, lat] of pts) {
        if (prevLon !== null) {
          let d = lon - prevLon;
          if (d > 180) d -= 360;
          else if (d < -180) d += 360;
          acc += d;
        } else acc = wrapLon(lon - proj.center.lon);
        prevLon = lon;
        if (proj.mode === 'flat') {
          const [x, y] = proj.toDotRel(acc, lat);
          cur.push([x, y]);
        } else {
          const [x, y, vis] = proj.toDot(lon, lat);
          if (!vis) {
            if (cur.length > 1) paths.push(cur);
            cur = [];
            continue;
          }
          cur.push([x, y]);
        }
      }
      if (cur.length > 1) paths.push(cur);
      if (proj.mode === 'flat') {
        // Also draw wrapped copies that fall inside the viewport.
        const extra = [];
        for (const path of paths) {
          const xs = path.map((p) => p[0]);
          const minX = Math.min(...xs);
          const maxX = Math.max(...xs);
          for (const off of [-proj.wrapOffset, proj.wrapOffset]) if (maxX + off >= 0 && minX + off < canvas.w) extra.push(path.map(([x, y]) => [x + off, y]));
        }
        paths.push(...extra);
      }
      return paths;
    };
    const colorFor = (f) => {
      if (focusF && f === focusF) return anim ? mix(f.color || t.text, '#ffffff', 0.3 + 0.4 * pulse(now, 700)) : '#ffffff';
      if (focusLayer && f.layer !== focusLayer) return dimColor;
      return f.color || t.text;
    };
    const isFocused = (f) => focusF && f === focusF;
    const dimmed = (f) => focusLayer && f.layer !== focusLayer;

    // Polygons first.
    for (const f of this.features) {
      if (!f.rings) continue;
      const color = colorFor(f);
      const screenRings = [];
      for (const ring of f.rings) {
        for (const path of projectPath(ring)) screenRings.push(path);
      }
      if (!screenRings.length) continue;
      if (!this.sat || isFocused(f)) canvas.fillRings(screenRings, dimmed(f) ? mix(t.panel, dimColor, 0.5) : mix(t.panel, color, isFocused(f) ? 0.45 : 0.22), 3);
      for (const ring of screenRings) {
        canvas.polyline([...ring, ring[0]], color, 4, isFocused(f) ? 0 : 3, Math.floor(now / 150));
      }
      polys.push({ f, rings: screenRings });
    }

    // Lines.
    for (const f of this.features) {
      if (!f.points || f.points.length < 2 || f.rings) continue;
      const color = colorFor(f);
      const focused = isFocused(f);
      const dash = focused ? 0 : f.dash || 0;
      const phase = anim && (f.flow || focused) ? Math.floor(now / 90) : 0;
      const paths = projectPath(f.points);
      const segs = [];
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const path of paths) {
        canvas.polyline(path, color, focused ? 7 : 5, dash, phase);
        if ((f.size || 0) >= 2 && !dimmed(f)) canvas.polyline(path.map(([x, y]) => [x, y + 1]), color, 5, dash, phase);
        for (let i = 1; i < path.length; i++) {
          segs.push([path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]]);
          minX = Math.min(minX, path[i - 1][0], path[i][0]);
          maxX = Math.max(maxX, path[i - 1][0], path[i][0]);
          minY = Math.min(minY, path[i - 1][1], path[i][1]);
          maxY = Math.max(maxY, path[i - 1][1], path[i][1]);
        }
      }
      if (!segs.length) continue;
      lines.push({ f, segs, minX, maxX, minY, maxY });
      // Flowing packet along the focused layer's lines.
      if (anim && (focused || (focusLayer && f.layer === focusLayer))) {
        const total = segs.reduce((a, [x0, y0, x1, y1]) => a + Math.hypot(x1 - x0, y1 - y0), 0);
        if (total > 4) {
          let target = ((now / (focused ? 1800 : 3600)) % 1) * total;
          for (const [x0, y0, x1, y1] of segs) {
            const len = Math.hypot(x1 - x0, y1 - y0);
            if (target <= len) {
              const u = len ? target / len : 0;
              const px = x0 + (x1 - x0) * u;
              const py = y0 + (y1 - y0) * u;
              canvas.glyph(Math.floor(px / 2), Math.floor(py / 4), '●', focused ? '#ffffff' : f.color || t.accent, { pri: 20 });
              break;
            }
            target -= len;
          }
        }
      }
      if (focused && f.nodes) {
        for (const nd of f.nodes) {
          const [x, y, vis] = proj.toDot(nd.lon, nd.lat);
          if (!vis) continue;
          canvas.glyph(Math.floor(x / 2), Math.floor(y / 4), '○', '#ffffff', { pri: 19 });
        }
      }
    }

    // Satellite ground track for the focused satellite.
    if (focusF && focusF.tle) {
      const track = groundTrack(focusF.tle, now, { back: 45, ahead: 95, stepMin: 1 });
      for (const path of projectPath(track)) canvas.polyline(path, mix(focusF.color || t.accent3, t.panel, 0.2), 6, 3, anim ? Math.floor(now / 120) : 0);
    }

    // Points (sorted so important features draw last / on top). Glyphs are
    // reserved for the important features at low zoom; the rest are dots.
    const zoom = this.view.mode === 'globe' ? this.view.zoom * 2.5 : this.view.zoom;
    const glyphMinSize = zoom < 2.5 ? 2 : zoom < 7 ? 1 : 0;
    const sorted = this.features.filter((f) => !f.rings && !(f.points && f.points.length >= 2));
    sorted.sort((a, b) => (a.size || 0) - (b.size || 0));
    for (const f of sorted) {
      let lat = f.lat;
      let lon = f.lon;
      if (f.tle) {
        const p = propagate(f.tle, now);
        lat = p.lat;
        lon = p.lon;
      } else if (f.moving && Number.isFinite(f.heading) && Number.isFinite(f.speedKt) && f.ts && anim) {
        const ageH = Math.min(10 / 60, Math.max(0, (now - f.ts) / 3600e3));
        const d = destination(lat, lon, f.heading, f.speedKt * 1.852 * ageH);
        lat = d.lat;
        lon = d.lon;
      }
      const [x, y, vis] = proj.toDot(lon, lat);
      if (!vis || x < -2 || y < -2 || x >= canvas.w + 2 || y >= canvas.h + 2) continue;
      const focused = isFocused(f);
      const color = colorFor(f);
      const cx = Math.floor(x / 2);
      const cy = Math.floor(y / 4);
      points.push({ f, x, y });
      const size = f.size || 0;
      if (size < glyphMinSize && !focused && !(focusLayer && f.layer === focusLayer)) {
        canvas.dot(x, y, color, 8);
        if (size >= 1) {
          canvas.dot(x + 1, y, color, 8);
          canvas.dot(x, y + 1, color, 8);
        }
        continue;
      }
      let glyph = f.glyph || '•';
      if (f.pulse && anim && !dimmed(f) && Math.floor(now / 500) % 2 === 1) glyph = size >= 2 ? '◎' : '◌';
      canvas.glyph(cx, cy, glyph, color, { pri: 10 + size + (focused ? 10 : 0), attr: focused || size >= 2 ? ATTR.BOLD : 0 });
      if (f.ring && anim && !dimmed(f)) {
        const r = ((now - (f.ts || now)) % 2400) / 2400;
        canvas.circle(x, y, 2 + r * 10, mix(t.panel, color, 1 - r), 6);
      }
      if (Number.isFinite(f.heading) && f.moving && !dimmed(f)) {
        const a = (f.heading - 90) * (Math.PI / 180);
        canvas.line(x + Math.cos(a) * 2, y + Math.sin(a) * 2, x + Math.cos(a) * 5, y + Math.sin(a) * 5, color, 7);
      }
      if (focused || (size >= 2 && this.view.zoom >= 4 && !focusLayer) || (focusLayer && f.layer === focusLayer && this.view.zoom >= 3)) {
        canvas.label(cx, cy, truncate(f.name, 24), focused ? '#ffffff' : color, { pri: focused ? 30 : 9, force: focused, attr: focused ? ATTR.BOLD : 0 });
      }
    }
    this.drawn = { points, lines, polys };
  }

  drawCard(ctx, inner, f, pinned) {
    const { s, t } = ctx;
    const w = Math.min(46, inner.w - 2);
    if (w < 24 || inner.h < 8) return;
    const rows = [];
    rows.push(['Position', fmtCoord(f.lat, f.lon)]);
    if (f.from && f.to) rows.push(['Route', `${f.fromName || fmtCoord(f.from[1], f.from[0])} → ${f.toName || fmtCoord(f.to[1], f.to[0])}`]);
    for (const r of (f.info || []).slice(0, 7)) rows.push(r);
    const lines = [];
    for (const [k, v] of rows) {
      const text = `${k}: ${v}`;
      for (const l of wrap(text, w - 4).slice(0, 2)) lines.push({ k, text: l });
    }
    const h = Math.min(inner.h - 2, lines.length + 4);
    // Place the card away from the cursor: bottom-left unless the cursor is there.
    const cursorLeft = this.hover ? this.hover.x < inner.w / 2 : false;
    const cursorBottom = this.hover ? this.hover.y > inner.h / 2 : false;
    const x = cursorLeft && cursorBottom ? inner.x + inner.w - w - 1 : inner.x + 1;
    const y = cursorBottom && !cursorLeft ? inner.y + 1 : inner.y + inner.h - h - 1;
    const box = rect(x, y, w, h);
    s.fill(box, ' ', { bg: t.sel });
    s.box(box, { fg: pinned ? t.warn : f.color || t.borderFocus, bg: t.sel }, 'round');
    const title = ` ${f.glyph ? `${f.glyph} ` : ''}${truncate(f.name, w - 8)} `;
    s.text(box.x + 1, box.y, title, { fg: f.color || t.title, bg: t.sel, attr: ATTR.BOLD });
    const sub = `${(f.layerLabel || f.layer || '').toUpperCase()}${pinned ? ' · PINNED' : ''}`;
    s.text(box.x + 2, box.y + 1, truncate(sub, w - 4), { fg: t.dim, bg: t.sel });
    lines.slice(0, h - 4).forEach((l, i) => {
      const y2 = box.y + 2 + i;
      const idx = l.text.indexOf(':');
      if (l.text.startsWith(`${l.k}:`) && idx > 0) {
        s.text(box.x + 2, y2, l.text.slice(0, idx + 1), { fg: t.accent, bg: t.sel });
        s.text(box.x + 2 + idx + 1, y2, l.text.slice(idx + 1), { fg: t.text, bg: t.sel }, w - 4 - idx - 1);
      } else s.text(box.x + 2, y2, l.text, { fg: t.text, bg: t.sel }, w - 4);
    });
    const hint = pinned ? 'Enter details · o link · c unpin' : 'click to pin · Enter details';
    s.text(box.x + 2, box.y + h - 1, truncate(hint, w - 4), { fg: t.muted, bg: t.sel });
    hit(ctx, box, { onClick: () => this.openDetail(f) });
  }
}

function rgb([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

function segDist(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const u = len2 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
  return Math.hypot(px - (x0 + dx * u), py - (y0 + dy * u));
}

function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polylineKm(points) {
  if (!points || points.length < 2) return 0;
  let km = 0;
  for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1][1], points[i - 1][0], points[i][1], points[i][0]);
  return km;
}

export { LAYERS as MAP_LAYERS };
