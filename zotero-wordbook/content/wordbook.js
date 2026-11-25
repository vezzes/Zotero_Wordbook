/* global Zotero, Services, Wordbook:true */
// Core: the global Wordbook object, settings, utilities, a simple event bus.
// The other modules (Store, Translator, Highlighter, Reader, Anki, UI) append
// themselves to this object from their own files (see the list in bootstrap.js).

Wordbook = {
  id: null,
  version: null,
  rootURI: null,
  _listeners: {},

  async init({ id, version, rootURI }) {
    Object.assign(this, { id, version, rootURI });
    await this.Store.init(); // 1. data
    await this.Dict.init(); //   offline dictionary
    this.Idioms.init(); //       database of idioms and phrasal verbs
    Zotero.Wordbook = this; //   access from the settings pane
    this.Highlighter.init(); // 2. highlighting (builds a regex from the dictionary)
    this.Reader.init(); //      3. subscription to the Zotero reader
  },

  shutdown() {
    delete Zotero.Wordbook;
    this.Reader.shutdown();
    this.Highlighter.shutdown();
    this.Store.shutdown();
    this._listeners = {};
  },

  // ---------- settings ----------
  getPref(key) {
    return Zotero.Prefs.get("wordbook." + key); // => extensions.zotero.wordbook.<key>
  },
  setPref(key, value) {
    return Zotero.Prefs.set("wordbook." + key, value);
  },

  // ---------- languages ----------
  // Book language (src) and translation language (dst). en and ru are supported (in both directions).
  LANGS: {
    en: { name: "Английский", short: "EN" },
    ru: { name: "Русский", short: "RU" },
  },
  langs() {
    let src = String(this.getPref("sourceLang") || "en");
    let dst = String(this.getPref("targetLang") || "ru");
    if (!this.LANGS[src]) src = "en";
    if (!this.LANGS[dst]) dst = "ru";
    if (src === dst) dst = Object.keys(this.LANGS).find((l) => l !== src);
    return { src, dst };
  },
  // Change the book / translation language (if the same language is chosen, the two languages are swapped)
  setLang(which, value) {
    const cur = this.langs();
    if (!this.LANGS[value]) return;
    if (which === "src") {
      this.setPref("sourceLang", value);
      this.setPref("targetLang", cur.dst === value ? cur.src : cur.dst);
    } else {
      this.setPref("targetLang", value);
      this.setPref("sourceLang", cur.src === value ? cur.dst : cur.src);
    }
    this.emit("words-changed"); // the highlight depends on the book language
  },

  // ---------- events ----------
  // A single event is used: "words-changed" (the dictionary changed -> redraw the highlight)
  on(evt, fn) {
    (this._listeners[evt] ||= new Set()).add(fn);
  },
  off(evt, fn) {
    this._listeners[evt]?.delete(fn);
  },
  emit(evt, data) {
    for (const fn of this._listeners[evt] || []) {
      try {
        fn(data);
      } catch (e) {
        this.log("listener error: " + e);
      }
    }
  },

  // ---------- utilities ----------
  log(msg) {
    Zotero.debug("[Wordbook] " + msg);
  },

  uuid() {
    return Services.uuid.generateUUID().toString().slice(1, -1);
  },

  // Word key: without case, extra spaces and punctuation at the edges
  normalize(text) {
    return String(text ?? "")
      .normalize("NFKC")
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[­​]/g, "") // soft hyphen, zero-width space
      .replace(/\s+/g, " ")
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
      .toLowerCase();
  },

  // Whether the selection qualifies as a "word or expression"
  isCandidate(text) {
    const key = this.normalize(text);
    if (!key || key.length > 80 || !/\p{L}/u.test(key)) return false;
    return key.split(" ").length <= (this.getPref("maxSelectionWords") || 6);
  },

  // A long selection (a sentence, a paragraph) is translated as a whole. Anything longer — we ask to select less.
  MAX_PASSAGE: 8000,

  // Selection text from a PDF -> readable text: joins hyphenated line breaks («trans-\nlation»), lines into paragraphs
  cleanPassage(text) {
    return String(text ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/(\p{L})[-\u00AD]\n\s*(?=\p{Ll})/gu, "$1")
      .replace(/[\u00AD\u200B]/g, "")
      .replace(/[ \t\f\v\u00A0]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{2,}/g, "\u0000")
      .replace(/\n/g, " ")
      .replace(/\u0000/g, "\n\n")
      .trim();
  },

  // debounce without the global setTimeout (its presence is not guaranteed in the bootstrap scope)
  debounce(fn, ms) {
    let gen = 0;
    return (...args) => {
      const g = ++gen;
      Zotero.Promise.delay(ms).then(() => {
        if (g === gen) fn(...args);
      });
    };
  },

  notify(text, isError = false) {
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Wordbook");
    pw.addDescription(text);
    pw.show();
    pw.startCloseTimer(isError ? 8000 : 4000);
  },
};
