/* global Zotero, IOUtils, PathUtils, Wordbook */
// Dictionary storage: a JSON file in the Zotero data directory + an in-memory Map.
//
// Dictionary entry:
// {
//   id, key,            // key — unique entry key: for English = word, for Russian "ru:word"
//   word, lang, dst,    // word = Wordbook.normalize(text); lang — language of the word (en|ru), dst — translation language
//   text,               // as selected by the user
//   translation,        // short translation into Russian (editable)
//   definition,         // explanation/dictionary article (shown in the dictionary window; not exported to Anki)
//   idiom,              // null | { type, expression } — idiom / phrasal verb / fixed expression
//   context,            // sentence fragment (empty for now — see README, roadmap)
//   source: { libraryID, attachmentKey, itemKey, title, page, pageIndex },  // attachmentKey+pageIndex — for "open in the book"
//   createdAt, updatedAt,
//   anki: null | { noteId, exportedAt, duplicate }   // null = not yet exported to Anki
// }

Wordbook.Store = {
  _words: new Map(), // key -> entry
  _path: null,
  _dirty: false,
  _saveSoon: null,
  _rev: 0, // grows on any change — invalidates the stem index
  _stemIdx: null,

  async init() {
    const dir = PathUtils.join(Zotero.DataDirectory.dir, "wordbook");
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    this._path = PathUtils.join(dir, "words.json");
    this._saveSoon = Wordbook.debounce(() => this.flush(), 500);

    if (await IOUtils.exists(this._path)) {
      try {
        const data = await IOUtils.readJSON(this._path);
        for (const w of data.words || []) {
          if (!w?.key) continue;
          // entries from earlier versions: an English word with a Russian translation
          if (!w.lang) w.lang = "en";
          if (!w.dst) w.dst = "ru";
          if (!w.word) w.word = w.key;
          this._words.set(w.key, w);
        }
      } catch (e) {
        Wordbook.log("Не удалось прочитать words.json: " + e);
        // do not overwrite the corrupted file — keep a copy
        await IOUtils.copy(this._path, this._path + ".broken-" + Date.now()).catch(() => {});
      }
    }
    Wordbook.log(`Загружено слов: ${this._words.size}`);
  },

  shutdown() {
    if (this._dirty) this.flush(); // we do not wait: IOUtils will finish the write
  },

  // Writes go strictly one at a time: two simultaneous writes to the same temporary file would corrupt the dictionary
  flush() {
    if (!this._path) return Promise.resolve();
    this._dirty = false;
    this._flushing = (this._flushing || Promise.resolve())
      .catch(() => {})
      .then(() =>
        IOUtils.writeJSON(
          this._path,
          { version: 1, words: this.all() },
          { tmpPath: this._path + ".tmp" } // atomic write
        )
      )
      .catch((e) => {
        this._dirty = true;
        Wordbook.log("Не удалось сохранить словарь: " + e);
      });
    return this._flushing;
  },

  // "words-updated" — any change (the dictionary window redraws its table);
  // "words-changed" — the set of words changed (the PDF highlight must be rebuilt)
  _changed(refreshHighlights = true) {
    this._rev++;
    this._dirty = true;
    this._saveSoon();
    if (refreshHighlights) Wordbook.emit("words-changed");
    Wordbook.emit("words-updated");
  },

  // ---------- reading ----------
  all() {
    return [...this._words.values()];
  },
  size() {
    return this._words.size;
  },
  has(key) {
    return this._words.has(key);
  },
  get(key) {
    return this._words.get(key);
  },

  // Unique entry key: English entries as before (word), other languages with a prefix
  idKey(word, lang) {
    return lang === "en" || !lang ? word : `${lang}:${word}`;
  },

  // Entries of one language (by default — the language of the open book)
  forLang(lang = Wordbook.langs().src) {
    return this.all().filter((w) => (w.lang || "en") === lang);
  },

  // Find an entry by text that actually appeared in the book: exact match first, then by word stems
  // («appeared to» -> «appear to», «Häuser» -> «Haus»). We search among the entries in the book's language.
  lookup(text, lang = Wordbook.langs().src) {
    const word = Wordbook.normalize(text);
    if (!word) return null;
    const exact = this._words.get(this.idKey(word, lang));
    if (exact) return exact;
    if (!this._stemIdx || this._stemIdx.rev !== this._rev) {
      this._stemIdx = { rev: this._rev, byLang: {} };
    }
    let idx = this._stemIdx.byLang[lang];
    if (!idx) {
      idx = this._stemIdx.byLang[lang] = new Map();
      for (const e of this.forLang(lang)) {
        const k = Wordbook.Morph.stemKey(e.word, lang);
        if (k && !idx.has(k)) idx.set(k, e);
      }
    }
    return idx.get(Wordbook.Morph.stemKey(word, lang)) || null;
  },

  pendingAnki() {
    return this.all().filter((w) => !w.anki);
  },

  // ---------- writing ----------
  add({ text, translation, definition = "", context = "", idiom = null, source = {}, lang, dst }) {
    const word = Wordbook.normalize(text);
    if (!word) throw new Error("Пустое слово");
    const pair = Wordbook.langs();
    lang = lang || pair.src;
    dst = dst || pair.dst;
    const key = this.idKey(word, lang);
    const existing = this._words.get(key);
    if (existing) return { entry: existing, created: false };

    const now = new Date().toISOString();
    const entry = {
      id: Wordbook.uuid(),
      key,
      word,
      lang,
      dst,
      text: String(text).trim(),
      translation: translation || "",
      definition,
      idiom,
      context,
      source,
      createdAt: now,
      updatedAt: now,
      anki: null,
    };
    this._words.set(key, entry);
    this._changed();
    return { entry, created: true };
  },

  update(key, patch) {
    const entry = this._words.get(key);
    if (!entry) return null;
    Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
    this._changed(false); // the key does not change, so the highlight need not be rebuilt
    return entry;
  },

  remove(key) {
    if (this._words.delete(key)) this._changed();
  },

  markContextSynced(key) {
    const entry = this._words.get(key);
    if (!entry?.anki) return;
    entry.anki.contextSynced = true;
    this._changed(false);
  },

  markExported(key, noteId, { duplicate = false } = {}) {
    const entry = this._words.get(key);
    if (!entry) return;
    entry.anki = { noteId, exportedAt: new Date().toISOString(), duplicate, contextSynced: true };
    this._changed(false); // the highlight does not change
  },
};
