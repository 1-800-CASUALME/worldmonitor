// Shared view scaffolding: a view with focusable panes, each holding a ListView.
import { ListView } from '../ui/widgets.mjs';

export class PaneView {
  constructor(app, { id, label, paneIds = [], sources = [] }) {
    this.app = app;
    this.id = id;
    this.label = label;
    this.paneIds = paneIds;
    this.focus = 0;
    this.lists = Object.fromEntries(paneIds.map((p) => [p, new ListView()]));
    this.sourceIds = sources;
  }

  get store() {
    return this.app.store;
  }

  get data() {
    return this.app.store.data;
  }

  get focusedPane() {
    return this.paneIds[this.focus];
  }

  isFocused(paneId) {
    return this.paneIds[this.focus] === paneId;
  }

  focusPane(paneId) {
    const i = this.paneIds.indexOf(paneId);
    if (i >= 0) this.focus = i;
  }

  sources() {
    return this.sourceIds;
  }

  mount() {
    for (const id of this.sourceIds) if (this.store.sources[id]?.lazy) this.store.want(id, true);
  }

  unmount() {
    for (const id of this.sourceIds) if (this.store.sources[id]?.lazy) this.store.want(id, false);
  }

  // Default key handling: left/right (h/l) move focus; the focused list handles the rest.
  onKey(ev) {
    if (ev.name === 'right' || ev.name === 'l') {
      this.focus = (this.focus + 1) % Math.max(1, this.paneIds.length);
      return true;
    }
    if (ev.name === 'left' || ev.name === 'h') {
      this.focus = (this.focus + this.paneIds.length - 1) % Math.max(1, this.paneIds.length);
      return true;
    }
    if (ev.name === 'enter') {
      this.activate(this.focusedPane);
      return true;
    }
    const list = this.lists[this.focusedPane];
    if (list && list.handleKey(ev)) return true;
    return false;
  }

  // Override: Enter / click on the selected row of a pane.
  activate() {}

  // Common list options wiring focus and activation.
  listOpts(paneId, extra = {}) {
    return {
      focused: this.isFocused(paneId),
      onFocus: () => this.focusPane(paneId),
      onActivate: () => this.activate(paneId),
      ...extra,
    };
  }

  selectedUrl() {
    return null;
  }

  hints() {
    return '';
  }
}

export function selectedItem(list, items) {
  return items && items.length ? items[Math.min(list.selected, items.length - 1)] : null;
}
