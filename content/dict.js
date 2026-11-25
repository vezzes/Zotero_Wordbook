/* global Zotero, IOUtils, PathUtils, Wordbook */
// Offline EN→RU dictionary.
//
// Data source: a dictionary in StarDict format (.ifo + .idx + .dict[.dz]). This format is
// used, for example, by V. K. Mueller's English-Russian dictionary (Mueller 7, GPL) —
// the recommended option. The user picks the .ifo file once (Tools → Wordbook:
// load dictionary…), the plugin parses it and saves it in <Zotero data directory>/wordbook/
// in its own compressed form. After that, no network is ever needed.
//
// If content/data/dictionary.json is placed inside the plugin (see save() for the format), it will be
// loaded as the default dictionary.

Wordbook.Dict = {
  entries: new Map(), // user-loaded StarDict dictionary: key -> article text (optional)
  basic: new Map(), // the English → Russian pack (filled by Packs): key -> "word / aspect|word|…"
  name: "",
  _path: null,

  get ready() {
    return this.entries.size > 0 || this.basic.size > 0;
  },

  async init() {
    // the dictionary loaded by the user (optional, takes priority over the English → Russian pack)
    this._path = PathUtils.join(Zotero.DataDirectory.dir, "wordbook", "dictionary.json");
    try {
      if (await IOUtils.exists(this._path)) {
        this._fill(await IOUtils.readJSON(this._path, { decompress: true }));
      }
    } catch (e) {
      Wordbook.log("Dict.init (пользовательский): " + e);
    }
    Wordbook.log(`Словарь, загруженный пользователем: «${this.name}», ${this.entries.size}`);
  },

  _fill(data) {
    this.name = data.name || "";
    this.entries = new Map(Object.entries(data.entries || {}));
  },

  async save() {
    const entries = Object.fromEntries(this.entries);
    await IOUtils.writeJSON(this._path, { version: 1, name: this.name, entries }, { compress: true });
  },

  async clear() {
    this.entries = new Map();
    this.name = "";
    await IOUtils.remove(this._path, { ignoreAbsent: true });
  },

  // ---------- StarDict import ----------
  async _gunzip(bytes, win) {
    const stream = new win.Blob([bytes]).stream().pipeThrough(new win.DecompressionStream("gzip"));
    return new Uint8Array(await new win.Response(stream).arrayBuffer());
  },

  async _readMaybeCompressed(base, exts, win) {
    for (const ext of exts) {
      const path = base + ext;
      if (await IOUtils.exists(path)) {
        const bytes = await IOUtils.read(path);
        return /\.(dz|gz)$/.test(ext) ? this._gunzip(bytes, win) : bytes;
      }
    }
    throw new Error("Не найден файл " + base + exts[0]);
  },

  _clean(text, type) {
    let t = text;
    if (/[hgx]/.test(type)) {
      t = t
        .replace(/<(br|\/p|\/div|\/li|\/tr)\b[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
        .replace(/&amp;/g, "&");
    }
    return t
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  },

  // Parse the article content, taking sametypesequence into account
  _article(dict, off, size, seq, dec) {
    const data = dict.subarray(off, off + size);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const parts = [];
    let p = 0;
    const types = seq ? seq.split("") : null;
    let idx = 0;
    while (p < data.length) {
      let type;
      if (types) {
        type = types[idx++];
        if (!type) break;
      } else {
        type = String.fromCharCode(data[p++]);
      }
      const isLast = types ? idx === types.length : false;
      let chunk;
      if (/[a-z]/.test(type)) {
        // string types
        let end = isLast ? data.length : data.indexOf(0, p);
        if (end < 0) end = data.length;
        chunk = data.subarray(p, end);
        p = isLast ? end : end + 1;
      } else {
        // binary: length-prefixed (the last one in sametypesequence runs to the end)
        if (isLast) {
          chunk = data.subarray(p);
          p = data.length;
        } else {
          const len = dv.getUint32(p);
          chunk = data.subarray(p + 4, p + 4 + len);
          p += 4 + len;
        }
      }
      if (/[mhgxtlk]/.test(type)) parts.push(this._clean(dec.decode(chunk), type));
    }
    return parts.filter(Boolean).join("\n");
  },

  // ifoPath — path to the .ifo file; win — a window with DecompressionStream/Blob/Response
  async importStarDict(ifoPath, win, onProgress = () => {}) {
    const dec = new TextDecoder("utf-8");
    const ifo = {};
    for (const line of dec.decode(await IOUtils.read(ifoPath)).split(/\r?\n/)) {
      const m = /^([^=]+)=(.*)$/.exec(line);
      if (m) ifo[m[1].trim()] = m[2].trim();
    }
    const base = ifoPath.replace(/\.ifo$/i, "");
    const seq = ifo.sametypesequence || null;
    const off64 = ifo.idxoffsetbits === "64";

    onProgress("Чтение файлов…");
    const idx = await this._readMaybeCompressed(base, [".idx", ".idx.gz"], win);
    const dict = await this._readMaybeCompressed(base, [".dict.dz", ".dict"], win);

    onProgress("Разбор словаря…");
    const idv = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
    const entries = new Map();
    let p = 0;
    let n = 0;
    while (p < idx.length) {
      let z = idx.indexOf(0, p);
      if (z < 0) break;
      const word = dec.decode(idx.subarray(p, z));
      p = z + 1;
      let off, size;
      if (off64) {
        off = idv.getUint32(p) * 4294967296 + idv.getUint32(p + 4);
        p += 8;
      } else {
        off = idv.getUint32(p);
        p += 4;
      }
      size = idv.getUint32(p);
      p += 4;

      const key = Wordbook.normalize(word);
      if (!key) continue;
      const text = this._article(dict, off, size, seq, dec);
      if (!text) continue;
      // several articles for one word (different case, homonyms) are concatenated
      entries.set(key, entries.has(key) ? entries.get(key) + "\n\n" + text : text);
      if (++n % 5000 === 0) {
        onProgress(`Разобрано статей: ${n}`);
        await Zotero.Promise.delay(0); // don't freeze the window
      }
    }
    if (!entries.size) throw new Error("В словаре не найдено ни одной статьи");

    this.entries = entries;
    this.name = ifo.bookname || "Словарь";
    onProgress("Сохранение…");
    await this.save();
    return { name: this.name, count: entries.size };
  },

  // ---------- lookup ----------
  // Returns { headword, text, form, source, items? } or null.
  //   headword — the headword that was found, form — "exact" | "lemma" | "phrase"
  //   source — "user" (loaded StarDict) | "basic" (built-in); for basic there is items — a list of translations
  lookup(selection) {
    if (!this.ready) return null;
    const user = this.entries.size ? this._lookupUser(selection) : null;
    if (user) return { ...user, source: "user" };
    return this._lookupBasic(selection);
  },

  _lookupBasic(selection) {
    const key = Wordbook.normalize(selection);
    if (!key || !this.basic.size) return null;
    const make = (headword, form) => {
      const items = this.basic.get(headword).split("|");
      return { headword, form, source: "basic", items, text: items.join("; ") };
    };
    const words = key.split(" ");
    if (words.length === 1) {
      // irregular forms: children -> child (for nouns the base form takes priority)
      const irr = Wordbook.Lemma.irregular(key);
      const base = irr?.bases.find((b) => this.basic.has(b));
      if (base && irr.plural) return make(base, "lemma");
      if (this.basic.has(key)) {
        const hit = make(key, "exact");
        if (base) {
          // "went", "left", "saw": the base form's meanings come first, then the match on the form itself
          hit.items = [...new Set([...this.basic.get(base).split("|"), ...hit.items])];
          hit.headword = base;
          hit.form = "lemma";
          hit.text = hit.items.join("; ");
        }
        return hit;
      }
      for (const c of Wordbook.Lemma.candidates(key)) if (this.basic.has(c)) return make(c, "lemma");
      return null;
    }
    if (this.basic.has(key)) return make(key, "exact");
    const rest = words.slice(1).join(" ");
    for (const c of Wordbook.Lemma.candidates(words[0])) {
      if (this.basic.has(c + " " + rest)) return make(c + " " + rest, "lemma");
    }
    return null;
  },

  _lookupUser(selection) {
    const key = Wordbook.normalize(selection);
    if (!key) return null;

    if (this.entries.has(key)) return { headword: key, text: this.entries.get(key), form: "exact" };

    const words = key.split(" ");
    if (words.length === 1) {
      for (const c of Wordbook.Lemma.candidates(key)) {
        if (this.entries.has(c)) return { headword: c, text: this.entries.get(c), form: "lemma" };
      }
      return null;
    }

    // Expression. 1) base form of the first word: "carried out" -> "carry out"
    const rest = words.slice(1).join(" ");
    for (const c of Wordbook.Lemma.candidates(words[0])) {
      const phrase = c + " " + rest;
      if (this.entries.has(phrase)) return { headword: phrase, text: this.entries.get(phrase), form: "lemma" };
    }
    // 2) a line containing this expression inside the article of the first or last word
    for (const w of [words[0], words[words.length - 1]]) {
      for (const c of Wordbook.Lemma.candidates(w)) {
        const hit = this._phraseInArticle(c, words, w);
        if (hit) return hit;
      }
    }
    return null;
  },

  // In Mueller's articles expressions are written with a tilde: "~ out выполнять". We substitute
  // the headword for "~" and look for a line starting with the expression.
  _phraseInArticle(headword, words, original) {
    const article = this.entries.get(headword);
    if (!article) return null;
    const forms = new Set();
    // spelling variants of the expression using the base form of each word
    const lemmas = words.map((w) => Wordbook.Lemma.candidates(w));
    forms.add(words.join(" "));
    forms.add(lemmas.map((c) => c[c.length > 1 ? 1 : 0] || c[0]).join(" "));
    forms.add(lemmas.map((c) => c[0]).join(" "));
    if (original === words[0]) forms.add([headword, ...words.slice(1)].join(" "));

    for (const rawLine of article.split("\n")) {
      const line = rawLine.replace(/~/g, headword).trim().toLowerCase();
      for (const f of forms) {
        if (f && (line.startsWith(f + " ") || line.startsWith("• " + f + " "))) {
          return { headword, text: rawLine.replace(/~/g, headword).trim(), form: "phrase" };
        }
      }
    }
    return null;
  },

  // ---------- short translation from an article ----------
  // Extracts meanings from an article. Heuristic tuned to Mueller's format:
  // «1. гл. 1) покидать, оставлять; бросать …» -> first: ["покидать", "оставлять", "бросать", …]
  // Returns { first, other } (first — the first part of speech).
  glosses(articleText, form = "exact") {
    const POS = /^(?:\d+\.\s*)?(?:сущ|гл|прил|нареч|предл|союз|мест|числ|межд|сокр|част|артикль|прич|вспом\. гл|мод\. гл)\.?(?:\s|$)/i;
    const first = []; // meanings of the first part of speech — the main translation
    const other = []; // other parts of speech — "other variants"
    let switched = false;
    const lines = articleText.split("\n");
    for (let line of lines) {
      line = line.replace(/\[[^\]]*\]/g, " ").trim(); // transcription
      if (!line) continue;
      if (/^[\x00-\x7F\s]+$/.test(line)) continue; // purely Latin lines (headword, examples)
      line = line.replace(/^(?:\d+[.)]|[а-яa-z]\))\s*/i, "");
      if (POS.test(line) && (first.length || other.length)) switched = true;
      while (POS.test(line)) line = line.replace(POS, "").replace(/^(?:\d+[.)]|[а-я]\))\s*/i, "").trim();
      line = line.replace(/^(?:\d+[.)]|[а-я]\))\s*/i, "");
      // labels at the start: (разг.), (амер.) …
      line = line.replace(/^(?:\([^)]{0,25}\)\s*)+/, "");
      // example line: Latin text comes before the Russian text
      if (/^[A-Za-z~]/.test(line)) {
        if (form !== "phrase") continue;
        line = line.replace(/^[A-Za-z~'’\- ]+\s*/, ""); // for expressions, strip the expression itself
      }
      for (let part of line.split(/[;,]/)) {
        part = part
          .replace(/\([^)]*\)/g, " ")
          .replace(/\s+/g, " ")
          .replace(/[.:]+$/, "")
          .trim();
        if (!part || part.length > 60 || !/[а-яё]/i.test(part)) continue;
        if (first.includes(part) || other.includes(part)) continue;
        (switched ? other : first).push(part);
      }
      if (first.length + other.length >= 14) break;
    }
    return { first, other };
  },
};
