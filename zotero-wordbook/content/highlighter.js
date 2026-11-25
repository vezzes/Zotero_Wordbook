/* global Zotero, Components, Wordbook */
// Highlighting of dictionary words in the Zotero PDF reader + a tooltip with the translation on hover.
//
// How it works:
//  • Zotero stores, for each page, the characters with their coordinates (view._pdfPages[i].chars).
//    The page text is built from them (PdfText.build); a single regular expression
//    finds all dictionary words in it, and per-line rectangles are computed for the matches.
//  • The rectangles are drawn in a .wbOverlay layer inside <div class="page"> — the same way as
//    Zotero draws its own annotations. Sizes are given as percentages of the page, so on
//    zoom the layer "moves" together with the page; after the page is re-rendered
//    (the pagerendered event or a check every 0.5 s) the layer is rebuilt.
//  • Tooltip: mousemove over the pages container → hit test of the point against the match rectangles.
//
// This relies on internal reader objects (view._iframeWindow, view._pdfPages,
// PDFViewerApplication) — see the "Risks" section in the README.

Wordbook.Highlighter = {
  _views: new Map(), // view (PDFView) -> state
  _matcher: null, // stem of the first word -> entry variants (see Morph.buildMatcher)
  _lang: null,
  _version: 0, // grows on any change to the dictionary/settings — invalidates the page cache
  _color: "rgba(255,200,0,0.4)",
  _onChange: null,

  init() {
    this.buildRegex();
    const refresh = Wordbook.debounce(() => this.refreshAll(), 150);
    this._onChange = () => refresh();
    Wordbook.on("words-changed", this._onChange);
  },

  shutdown() {
    Wordbook.off("words-changed", this._onChange);
    for (const view of [...this._views.keys()]) this.detach(view);
  },

  // ---------- dictionary for stem-based word search ----------
  _computeColor() {
    const raw = String(Wordbook.getPref("highlightColor") || "#ffc800").trim();
    if (/^rgba?\(/i.test(raw)) return raw;
    let hex = raw.replace("#", "");
    if (hex.length === 3) hex = hex.replace(/./g, "$&$&");
    const n = parseInt(hex.padEnd(6, "0").slice(0, 6), 16) || 0xffc800;
    const op = Math.min(100, Math.max(5, Number(Wordbook.getPref("highlightOpacity")) || 40)) / 100;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${op})`;
  },

  // Builds the stem-based search for entries in the book's language. Only words of that language are highlighted.
  buildRegex() {
    this._version++;
    this._color = this._computeColor();
    this._lang = Wordbook.langs().src;
    const entries = Wordbook.Store.forLang(this._lang).map((w) => ({ id: w.key, word: w.word || w.key }));
    this._matcher = entries.length ? Wordbook.Morph.buildMatcher(entries, this._lang) : null;
  },

  // ---------- attaching to the PDF view ----------
  // Returns true if the view is ready and highlighting is attached
  attach(view) {
    if (this._views.has(view)) return true;
    const win = view?._iframeWindow;
    const app = win?.PDFViewerApplication;
    const doc = win?.document;
    const container = doc?.getElementById("viewerContainer");
    if (!app?.pdfViewer || !container) return false;

    const state = {
      view,
      win,
      doc,
      app,
      container,
      tip: null,
      sticky: false,
      token: 0,
      current: null,
      hits: new Map(), // pageIndex -> [{ text, rects: [[x1,y1,x2,y2] as fractions of the page] }]
      sigs: new Map(), // pageIndex -> signature of the last render
      cache: new Map(), // pageIndex -> { version, chars, matches }
      unsub: null,
    };
    state.syncSoon = Wordbook.debounce(() => this.sync(view), 30);

    this._injectStyle(state);

    state.onMove = (e) => this._onMove(state, e);
    state.onCancel = () => this._cancel(state);
    state.onLeave = () => {
      if (!state.sticky) this._cancel(state); // a pinned tooltip (after a click) must survive the cursor moving to the button
    };
    state.onClick = (e) => this._onClick(state, e);
    container.addEventListener("mousemove", state.onMove);
    container.addEventListener("mousedown", state.onCancel);
    container.addEventListener("mouseleave", state.onLeave);
    container.addEventListener("scroll", state.onCancel);
    container.addEventListener("click", state.onClick);

    this._subscribe(state);
    this._views.set(view, state);
    this.sync(view);
    return true;
  },

  detach(view) {
    const state = this._views.get(view);
    if (!state) return;
    this._views.delete(view);
    try {
      state.unsub?.();
      state.container.removeEventListener("mousemove", state.onMove);
      state.container.removeEventListener("mousedown", state.onCancel);
      state.container.removeEventListener("mouseleave", state.onLeave);
      state.container.removeEventListener("scroll", state.onCancel);
      state.container.removeEventListener("click", state.onClick);
      this._hideTip(state);
      for (const el of state.doc.querySelectorAll(".wbOverlay")) el.remove();
      state.doc.getElementById("wbStyle")?.remove();
    } catch (e) {
      // the reader window is already closed — that's fine
    }
  },

  refreshAll() {
    this.buildRegex();
    for (const state of this._views.values()) {
      state.sigs.clear();
      state.cache.clear();
      this._injectStyle(state);
    }
    for (const view of this._views.keys()) this.sync(view);
  },

  // pdf.js events (pagerendered) arrive faster than the timer. The function must be "exported"
  // into the reader window: it lives in a different security context. If that fails —
  // the highlight will be refreshed by the periodic check in reader.js.
  _subscribe(state) {
    try {
      const cb = Components.utils.exportFunction(() => state.syncSoon(), state.win);
      const bus = state.app.eventBus;
      bus.on("pagerendered", cb);
      bus.on("textlayerrendered", cb);
      state.unsub = () => {
        try {
          bus.off("pagerendered", cb);
          bus.off("textlayerrendered", cb);
        } catch (e) {}
      };
    } catch (e) {
      Wordbook.log("eventBus недоступен, обновляем по таймеру: " + e);
    }
  },

  // ---------- page rendering ----------
  // Cheap to call often: pages with an unchanged signature are skipped
  sync(view) {
    const state = this._views.get(view);
    if (!state) return;
    if (this._lang !== Wordbook.langs().src || this._color !== this._computeColor()) this.buildRegex(); // the language or color was changed in the settings
    const viewer = state.app.pdfViewer;
    const count = viewer.pagesCount || 0;
    for (let i = 0; i < count; i++) {
      const pv = viewer.getPageView(i);
      if (!pv?.div || !pv.viewport || !(pv.renderingState > 0)) continue; // the page has not been rendered yet
      try {
        this._renderPage(state, i, pv);
      } catch (e) {
        Wordbook.log(`render page ${i}: ${e}`);
      }
    }
  },

  _findMatches(chars) {
    const built = Wordbook.PdfText.build(chars);
    const out = [];
    for (const m of Wordbook.Morph.findAll(built.text, this._matcher, this._lang)) {
      const rects = Wordbook.PdfText.rectsForRange(chars, built, m.start, m.end);
      if (!rects.length) continue;
      const text = built.text.slice(m.start, m.end);
      const entry = Wordbook.Store.get(m.id);
      // a different form of a saved word: remember the sentence — it will be used to translate exactly this form
      const ctx = "";
      out.push({ text, id: m.id, ctx, rects });
    }
    return out;
  },

  _renderPage(state, i, pv) {
    const chars = state.view._pdfPages?.[i]?.chars;
    const pageDiv = pv.div;
    let overlay = pageDiv.querySelector(":scope > .wbOverlay");

    if (!this._matcher || !chars?.length) {
      overlay?.remove();
      state.hits.delete(i);
      state.sigs.delete(i);
      return;
    }

    const vp = pv.viewport;
    const sig = [this._version, chars.length, vp.width, vp.height, vp.rotation].join("|");
    if (overlay && state.sigs.get(i) === sig) return;

    let cached = state.cache.get(i);
    if (!cached || cached.version !== this._version || cached.chars !== chars) {
      cached = { version: this._version, chars, matches: this._findMatches(chars) };
      state.cache.set(i, cached);
    }

    // PDF -> page fractions (0..1), accounting for scale and rotation
    const tf = vp.transform;
    const apply = (x, y) => [tf[0] * x + tf[2] * y + tf[4], tf[1] * x + tf[3] * y + tf[5]];
    const toFrac = (r) => {
      const [x1, y1] = apply(r[0], r[1]);
      const [x2, y2] = apply(r[2], r[3]);
      return [
        Math.min(x1, x2) / vp.width,
        Math.min(y1, y2) / vp.height,
        Math.max(x1, x2) / vp.width,
        Math.max(y1, y2) / vp.height,
      ];
    };
    const hits = cached.matches.map((m) => ({ text: m.text, id: m.id, ctx: m.ctx, rects: m.rects.map(toFrac) }));
    state.hits.set(i, hits);

    const doc = state.doc;
    if (!overlay) {
      overlay = doc.createElement("div");
      overlay.className = "wbOverlay";
      // display: contents — like Zotero's annotation layer: the rectangles are drawn directly
      // on the page and blended (multiply) with its canvas
      overlay.style.display = "contents";
      pageDiv.append(overlay);
    }
    const pct = (v) => (v * 100).toFixed(3);
    const kids = [];
    for (const h of hits) {
      for (const f of h.rects) {
        const d = doc.createElement("div");
        d.className = "wbRect";
        d.style.cssText =
          `position:absolute;left:${pct(f[0])}%;top:${pct(f[1])}%;` +
          `width:${pct(f[2] - f[0])}%;height:${pct(f[3] - f[1])}%;` +
          `background:${this._color};mix-blend-mode:multiply;border-radius:2px;pointer-events:none;`;
        kids.push(d);
      }
    }
    overlay.replaceChildren(...kids);
    state.sigs.set(i, sig);
  },

  // ---------- tooltip ----------
  _injectStyle(state) {
    const doc = state.doc;
    let style = doc.getElementById("wbStyle");
    if (!style) {
      style = doc.createElement("style");
      style.id = "wbStyle";
      (doc.head || doc.documentElement).append(style);
    }
    style.textContent = `
      .wbTip { position: fixed; z-index: 2147483647; max-width: 320px; padding: 8px 12px;
        border-radius: 8px; background: #1f2328; color: #fff; pointer-events: none;
        font: 13px/1.35 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.35); }
      .wbTipTr { font-size: 15px; font-weight: 600; }
      .wbTipSrc { margin-top: 3px; font-size: 11px; opacity: .6; }
      .wbTipDel { display: block; width: 100%; margin-top: 8px; padding: 5px 10px; border: 0; border-radius: 6px;
        background: #8c2f39; color: #fff; font: 12px system-ui, sans-serif; cursor: pointer; }
      .wbTipDel:hover { background: #a53a45; }
    `;
  },

  // Highlight segment under the cursor: { hit, rect, box } or null
  _hitAt(state, e) {
    const pageEl = e.target?.closest?.(".page");
    const idx = pageEl ? parseInt(pageEl.dataset.pageNumber, 10) - 1 : -1;
    const hits = state.hits.get(idx);
    if (!hits?.length) return null;

    // Frame of the page's "inner" block — the layer's percentages are relative to it
    const b = pageEl.getBoundingClientRect();
    const box = {
      left: b.left + pageEl.clientLeft,
      top: b.top + pageEl.clientTop,
      width: pageEl.clientWidth || b.width,
      height: pageEl.clientHeight || b.height,
    };
    const fx = (e.clientX - box.left) / box.width;
    const fy = (e.clientY - box.top) / box.height;
    for (const h of hits) {
      for (const r of h.rects) {
        if (fx >= r[0] && fx <= r[2] && fy >= r[1] && fy <= r[3]) return { hit: h, rect: r, box };
      }
    }
    return null;
  },

  _onMove(state, e) {
    if (state.sticky) return; // a pinned tooltip is dismissed by a click elsewhere or by scrolling
    const found = this._hitAt(state, e);
    if (!found) return this._cancel(state);
    this._hover(state, found.hit, found.rect, found.box);
  },

  // Click on a highlighted word (not a selection and not a double click): the tooltip gets pinned and receives a «Удалить из словаря» (Remove from dictionary) button
  _onClick(state, e) {
    if (e.button !== 0 || e.detail > 1) return;
    if (state.win.getSelection?.()?.toString()) return; // that was a text selection
    const found = this._hitAt(state, e);
    if (!found) return;
    this._hideTip(state);
    state.current = found.hit;
    state.token++;
    this._showTip(state, found.hit, found.rect, found.box, true);
  },

  _hover(state, hit, rect, box) {
    if (state.current === hit) return; // same segment — the tooltip is already shown or pending
    this._hideTip(state);
    state.current = hit;
    const token = ++state.token;
    const delay = Wordbook.getPref("hoverDelay") ?? 250;
    Zotero.Promise.delay(delay).then(() => {
      if (token === state.token && state.current === hit) this._showTip(state, hit, rect, box);
    });
  },

  _cancel(state) {
    state.current = null;
    state.token++;
    this._hideTip(state);
  },

  _showTip(state, hit, rect, box, sticky = false) {
    const entry = Wordbook.Store.get(hit.id) || Wordbook.Store.lookup(hit.text);
    if (!entry) return;
    this._hideTip(state);

    const doc = state.doc;
    const tip = doc.createElement("div");
    tip.className = "wbTip";
    const tr = doc.createElement("div");
    tr.className = "wbTipTr";
    const base = entry.word || entry.key;
    const isForm = Wordbook.normalize(hit.text) !== base;
    const trans = entry.translation || "перевод не указан";
    // Another form: explicitly show the saved word and its translation («quivering — дрожащий») rather than the translation of this form
    tr.textContent = isForm ? `${base} — ${trans}` : trans;
    const src = doc.createElement("div");
    src.className = "wbTipSrc";
    src.textContent = entry.idiom ? `🔖 ${entry.idiom.type} · ${base}` : base;
    tip.append(tr);
    if (!isForm) tip.append(src); // for another form the word is already on the first line («quivering — дрожащий»)

    if (sticky) {
      tip.style.pointerEvents = "auto";
      const del = doc.createElement("button");
      del.className = "wbTipDel";
      del.textContent = "Удалить из словаря";
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._hideTip(state);
        Wordbook.Store.remove(entry.key); // the highlight is updated via the words-changed event
      });
      tip.append(del);
    }
    (doc.body || doc.documentElement).append(tip);
    state.tip = tip;
    state.sticky = sticky;

    const lineLeft = box.left + rect[0] * box.width;
    const lineTop = box.top + rect[1] * box.height;
    const lineBottom = box.top + rect[3] * box.height;
    const tb = tip.getBoundingClientRect();
    const left = Math.max(4, Math.min(lineLeft, state.win.innerWidth - tb.width - 4));
    const below = lineBottom + 6;
    const top = below + tb.height > state.win.innerHeight ? lineTop - tb.height - 6 : below;
    tip.style.left = left + "px";
    tip.style.top = Math.max(4, top) + "px";
  },

  _hideTip(state) {
    state.tip?.remove();
    state.tip = null;
    state.sticky = false;
  },
};
