/* global Wordbook */
// Morphology works the same for the Snowball languages (English, Russian, German, French, Spanish, Portuguese):
// a word is reduced to its stem, and words and expressions are compared by stems.
// So «appeared to» finds «appear to», «книгу» finds «книга», «Häuser» finds «Haus».
// Short words (up to 4 letters) are compared as is, to avoid accidental matches.
// Chinese has no spaces and no inflection: a saved word is searched in the text as a plain substring (longest first).

Wordbook.Morph = {
  _ALG: { en: "english", ru: "russian", de: "german", fr: "french", es: "spanish", pt: "portuguese" },
  _stemmers: {},
  _cache: {},
  _TOKEN: /[\p{L}\p{M}]+(?:['\u2019][\p{L}\p{M}]+)*/gu,
  _SEP: /^[\s\-\u2010\u2011]+$/,

  stem(word, lang) {
    const cache = (this._cache[lang] ||= new Map());
    let r = cache.get(word);
    if (r !== undefined) return r;
    let w = String(word).toLowerCase().normalize("NFC");
    if (lang === "ru") w = w.replace(/ё/g, "е");
    if (lang === "en") w = w.replace(/['\u2019]s$/, "");
    if (lang === "zh" || !this._ALG[lang]) {
      r = w; // Chinese and languages without a stemmer: the word as is
    } else if (w.length < 4) {
      r = w;
    } else {
      try {
        const st = (this._stemmers[lang] ||= Wordbook.Snowball.newStemmer(this._ALG[lang] || "english"));
        r = st.stem(w) || w;
        if (lang === "en") {
          // Snowball also strips derivational suffixes (department → depart, decision → decis),
          // which makes different words merge. We reduce to the stem only inflection (-s, -ed, -ing).
          const core = w.replace(/(?:ies|es|s|ed|ing)$/, "");
          if (core.length - r.length >= 2) r = /[^s]s$/.test(w) ? w.slice(0, -1) : w;
        }
      } catch (e) {
        r = w;
      }
    }
    if (cache.size > 50000) cache.clear();
    cache.set(word, r);
    return r;
  },

  // Words of the text: [{ w, s, e }] (word, start, end)
  tokens(text) {
    const out = [];
    for (const m of String(text).matchAll(this._TOKEN)) out.push({ w: m[0], s: m.index, e: m.index + m[0].length });
    return out;
  },

  // Stems of the words of a phrase
  stems(phrase, lang) {
    return this.tokens(phrase).map((t) => this.stem(t.w, lang));
  },

  // Stem search key: "appear to"
  stemKey(phrase, lang) {
    return this.stems(phrase, lang).join(" ");
  },

  // entries: [{ id, word }] of one language -> Map(stem of the first word -> [{ stems, id }]), longest expressions first
  // Chinese: { zh: [{ word, id }] } sorted by length
  buildMatcher(entries, lang) {
    if (lang === "zh") {
      const list = entries.map((e) => ({ word: String(e.word).normalize("NFKC").replace(/\s+/g, ""), id: e.id })).filter((e) => e.word);
      list.sort((a, b) => b.word.length - a.word.length);
      return { zh: list };
    }
    const map = new Map();
    for (const e of entries) {
      const stems = this.stems(e.word, lang);
      if (!stems.length) continue;
      const list = map.get(stems[0]) || [];
      list.push({ stems, id: e.id });
      map.set(stems[0], list);
    }
    for (const list of map.values()) list.sort((a, b) => b.stems.length - a.stems.length);
    return map;
  },

  // All occurrences of dictionary words in the text: [{ start, end, id }]
  findAll(text, matcher, lang) {
    if (lang === "zh") return this._findAllSubstring(text, matcher.zh || []);
    const toks = this.tokens(text);
    const st = toks.map((t) => this.stem(t.w, lang));
    const out = [];
    for (let i = 0; i < toks.length; ) {
      const cands = matcher.get(st[i]);
      let hit = null;
      if (cands) {
        for (const c of cands) {
          const n = c.stems.length;
          if (i + n > toks.length) continue;
          let ok = true;
          for (let k = 0; k < n && ok; k++) {
            if (st[i + k] !== c.stems[k]) ok = false;
            else if (k > 0 && !this._SEP.test(text.slice(toks[i + k - 1].e, toks[i + k].s))) ok = false;
          }
          if (ok) {
            hit = c;
            break;
          }
        }
      }
      if (hit) {
        const last = toks[i + hit.stems.length - 1];
        out.push({ start: toks[i].s, end: last.e, id: hit.id });
        i += hit.stems.length;
      } else {
        i++;
      }
    }
    return out;
  },

  // Chinese: literal occurrences, the longest words first, without overlaps
  _findAllSubstring(text, list) {
    const out = [];
    const taken = new Uint8Array(text.length);
    for (const { word, id } of list) {
      for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + word.length)) {
        let free = true;
        for (let k = at; k < at + word.length; k++) if (taken[k]) free = false;
        if (!free) continue;
        taken.fill(1, at, at + word.length);
        out.push({ start: at, end: at + word.length, id });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  },
};
