/* global Zotero, IOUtils, PathUtils, Wordbook, Components */
// Offline dictionary packs.
//
// Nothing is bundled with the plugin: the user downloads the dictionaries they need in the settings
// (Edit → Settings → Wordbook → «Офлайн-словари»). One pack = one direction (e.g. de → en).
//
// Where packs come from:  <packsUrl>/catalog.json  and  <packsUrl>/<file>   (the GitHub release «dictionaries»
//   of the plugin repository; see tools/build_packs.py and .github/workflows/build-dictionaries.yml).
// Where they are stored:  <Zotero data directory>/wordbook/packs/<id>.json  +  index.json
//
// Pack file (JSON):
//   { "format": 1, "id": "de-en", "src": "de", "dst": "en", "version": "2026-11-22", "name": "…",
//     "license": "…", "source": "…",
//     "entries": { "haus": "house|home|building", … },          // key (lowercase) -> translations separated by "|"
//     "idioms":  { … }                                          // only in en-ru: the idiom database (see idioms.js) }
// Catalog (JSON):
//   { "format": 1, "updated": "…", "packs": [ { "id", "src", "dst", "name", "file", "size", "entries",
//                                              "sha256", "version", "license", "source" } ] }
//
// Only the pack of the current language pair is kept in memory (Packs.prepare()).

Wordbook.Packs = {
  DEFAULT_URL: "https://github.com/vezzes/Zotero_Wordbook/releases/download/dictionaries/",
  _dir: null,
  _index: {}, // id -> { id, src, dst, name, version, entries, size, installedAt }
  _cur: null, // the loaded pack of the current pair: { id, src, dst, entries: Map, … }
  _want: null,
  catalog: null, // the last downloaded catalog
  busy: new Set(), // ids being downloaded now

  get baseUrl() {
    let u = String(Wordbook.getPref("packsUrl") || "").trim() || this.DEFAULT_URL;
    if (!u.endsWith("/")) u += "/";
    return u;
  },

  idOf(src, dst) {
    return `${src}-${dst}`;
  },

  async init() {
    this._dir = PathUtils.join(Zotero.DataDirectory.dir, "wordbook", "packs");
    try {
      const f = PathUtils.join(this._dir, "index.json");
      if (await IOUtils.exists(f)) this._index = (await IOUtils.readJSON(f)) || {};
    } catch (e) {
      Wordbook.log("Packs.init: " + e);
      this._index = {};
    }
    await this.prepare();
  },

  // Is the pack of this pair installed?
  has(src, dst) {
    return !!this._index[this.idOf(src, dst)];
  },

  installed() {
    return Object.values(this._index);
  },

  // The pack of the current pair, if loaded
  current() {
    const { src, dst } = Wordbook.langs();
    return this._cur && this._cur.id === this.idOf(src, dst) ? this._cur : null;
  },

  // Loads into memory the pack of the current language pair (the others are released)
  async prepare() {
    const { src, dst } = Wordbook.langs();
    const id = this.idOf(src, dst);
    this._want = id;
    if (this._cur && this._cur.id === id) return;
    this._release();
    if (!this._index[id]) return;
    try {
      const obj = await IOUtils.readJSON(PathUtils.join(this._dir, id + ".json"));
      if (this._want !== id) return; // the pair was changed while the file was being read
      this._attach(id, obj);
      Wordbook.emit("words-changed"); // the offline translation has become available
    } catch (e) {
      Wordbook.log(`Packs.prepare(${id}): ${e}`);
    }
  },

  _attach(id, obj) {
    this._cur = { id, src: obj.src, dst: obj.dst, name: obj.name, entries: new Map(Object.entries(obj.entries || {})), _stem: null };
    if (id === "en-ru") {
      // English → Russian keeps its richer logic (English word-form rules, idioms)
      Wordbook.Dict.basic = this._cur.entries;
      Wordbook.Idioms.load(obj.idioms || {});
    }
  },

  _release() {
    this._cur = null;
    if (Wordbook.Dict) Wordbook.Dict.basic = new Map();
    if (Wordbook.Idioms) Wordbook.Idioms.load({});
  },

  // ---------- catalog ----------
  async fetchCatalog() {
    let resp;
    try {
      resp = await Zotero.HTTP.request("GET", this.baseUrl + "catalog.json?t=" + Date.now(), {
        responseType: "json",
        timeout: 20000,
        successCodes: false,
      });
    } catch (e) {
      throw new Error("Нет связи: не удалось получить список словарей");
    }
    if (resp.status === 404) throw new Error("Список словарей пока не опубликован");
    if (resp.status !== 200 || !resp.response || !Array.isArray(resp.response.packs)) {
      throw new Error(`Не удалось получить список словарей (код ${resp.status})`);
    }
    this.catalog = resp.response;
    return this.catalog;
  },

  // "up to date" | "new" (not installed) | "update" (the catalog has a newer version)
  stateOf(meta) {
    const have = this._index[meta.id];
    if (!have) return "new";
    return String(have.version) !== String(meta.version) ? "update" : "ok";
  },

  // ---------- install / remove ----------
  async install(meta, onProgress = () => {}) {
    if (this.busy.has(meta.id)) return;
    this.busy.add(meta.id);
    try {
      let resp;
      try {
        resp = await Zotero.HTTP.request("GET", this.baseUrl + meta.file, {
          responseType: "arraybuffer",
          timeout: 180000,
          successCodes: false,
          requestObserver: (xhr) => {
            xhr.onprogress = (ev) => onProgress(ev.loaded, ev.total || meta.size || 0);
          },
        });
      } catch (e) {
        throw new Error("Нет связи: не удалось скачать словарь");
      }
      if (resp.status !== 200) throw new Error(`Не удалось скачать словарь (код ${resp.status})`);
      const bytes = new Uint8Array(resp.response);
      if (meta.sha256) {
        const got = await this._sha256(bytes);
        if (got && got !== String(meta.sha256).toLowerCase()) throw new Error("Файл словаря повреждён (не совпала контрольная сумма), попробуйте ещё раз");
      }
      let obj;
      try {
        obj = JSON.parse(new TextDecoder("utf-8").decode(bytes));
      } catch (e) {
        throw new Error("Файл словаря не удалось прочитать");
      }
      if (obj.format !== 1 || obj.id !== meta.id || !obj.entries || typeof obj.entries !== "object") {
        throw new Error("Этот файл не похож на словарь Wordbook");
      }
      await IOUtils.makeDirectory(this._dir, { createAncestors: true, ignoreExisting: true });
      await IOUtils.write(PathUtils.join(this._dir, meta.id + ".json"), bytes);
      this._index[meta.id] = {
        id: meta.id,
        src: meta.src,
        dst: meta.dst,
        name: meta.name,
        version: meta.version,
        entries: Object.keys(obj.entries).length,
        size: bytes.length,
        installedAt: new Date().toISOString(),
      };
      await this._saveIndex();
      if (this._cur && this._cur.id === meta.id) this._release(); // re-read the updated pack
      await this.prepare();
      Wordbook.emit("packs-changed");
    } finally {
      this.busy.delete(meta.id);
    }
  },

  async remove(id) {
    if (!this._index[id]) return;
    await IOUtils.remove(PathUtils.join(this._dir, id + ".json"), { ignoreAbsent: true });
    delete this._index[id];
    await this._saveIndex();
    if (this._cur && this._cur.id === id) this._release();
    Wordbook.emit("packs-changed");
    Wordbook.emit("words-changed");
  },

  async _saveIndex() {
    await IOUtils.makeDirectory(this._dir, { createAncestors: true, ignoreExisting: true });
    await IOUtils.writeJSON(PathUtils.join(this._dir, "index.json"), this._index);
  },

  async _sha256(bytes) {
    try {
      if (globalThis.crypto?.subtle) {
        const h = await globalThis.crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("");
      }
    } catch (e) {
      // fall through to XPCOM
    }
    try {
      const h = Components.classes["@mozilla.org/security/hash;1"].createInstance(Components.interfaces.nsICryptoHash);
      h.init(h.SHA256);
      h.update(bytes, bytes.length);
      const bin = h.finish(false);
      return Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    } catch (e) {
      Wordbook.log("sha256 is not available: " + e);
      return null; // the check is skipped (the transfer is protected by HTTPS)
    }
  },

  shutdown() {
    this._cur = null;
    this.catalog = null;
  },
};

// Lookup in a generic pack (any pair except the richer en → ru, which uses Dict and Idioms)
Wordbook.PackDict = {
  // "~zhōng guó|China|…" -> { reading: "zhōng guó", items: ["China", …] }
  _parse(raw) {
    const parts = String(raw)
      .split("|")
      .map((x) => x.trim())
      .filter(Boolean);
    const reading = parts.length && parts[0].startsWith("~") ? parts.shift().slice(1) : "";
    return { reading, items: parts };
  },

  // The value of a key: a translation, or "→headword" (the key is an inflected form of the headword)
  _resolve(pack, key, raw, form) {
    let hw = key;
    if (String(raw).startsWith("→")) {
      hw = String(raw).slice(1);
      raw = pack.entries.get(hw);
      form = "lemma";
      if (!raw || String(raw).startsWith("→")) return null;
    }
    return { headword: hw, form, ...this._parse(raw) };
  },

  // -> { headword, items: [..], reading, form: "exact" | "lemma" } | null
  lookup(text) {
    const pack = Wordbook.Packs.current();
    if (!pack) return null;
    const key = Wordbook.normalize(text);
    if (!key) return null;
    const exact = pack.entries.get(key);
    if (exact) {
      const r = this._resolve(pack, key, exact, "exact");
      if (r) return r;
    }
    if (pack.src === "zh") return null; // Chinese has no word forms
    // another form of the word: compare by stems
    if (!pack._stem) {
      pack._stem = new Map();
      for (const [k, v] of pack.entries) {
        if (String(v).startsWith("→")) continue; // forms are found directly; the stem index is for the headwords
        const sk = Wordbook.Morph.stemKey(k, pack.src);
        const prev = pack._stem.get(sk);
        if (sk && (!prev || k.length < prev.length)) pack._stem.set(sk, k);
      }
    }
    const hw = pack._stem.get(Wordbook.Morph.stemKey(key, pack.src));
    if (hw) {
      const raw = pack.entries.get(hw);
      if (raw && !String(raw).startsWith("→")) return { headword: hw, form: "lemma", ...this._parse(raw) };
    }
    return null;
  },
};
