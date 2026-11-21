/* global Zotero, Wordbook */
// Recognition of fixed expressions (idioms, phrasal verbs, collocations) — offline.
//
// Data: content/data/idioms.json (built by tools/build_data.py):
//   "expression" -> [type_code, russian_translation, english_explanation]
//   codes: i idiom · p phrasal verb · x fixed expression · s proverb
//         v verbal expression (WordNet) · n compound noun (WordNet, "weak")
//
// What analyze(selection, sentence) does:
//   exact   — the whole selection is itself an expression ("break the ice", "carried out");
//   inside  — expressions within a long selection ("Every citation traces back" -> "trace back");
//   context — a single word is selected, but in the sentence it is part of an expression
//             ("traces" selected, the sentence has "traces back to" -> "trace back to").
// Word forms are reduced to the base form: "kicked the bucket" = "kick the bucket",
// "took his time" = "take one's time".

Wordbook.Idioms = {
  map: new Map(),
  vocab: new Set(), // all words that occur in expressions
  MAX_N: 7,

  LABELS: {
    i: "идиома",
    p: "фразовый глагол",
    x: "устойчивое выражение",
    s: "пословица",
    v: "глагольное выражение",
    n: "составное существительное",
  },

  init() {
    try {
      const raw = Zotero.File.getContentsFromURL("chrome://wordbook/content/data/idioms.json");
      this.load(JSON.parse(raw));
    } catch (e) {
      Wordbook.log("Idioms.init: " + e);
    }
    Wordbook.log(`Выражений загружено: ${this.map.size}`);
  },

  load(obj) {
    this.map = new Map(Object.entries(obj));
    this.vocab = new Set();
    for (const key of this.map.keys()) for (const w of key.split(" ")) this.vocab.add(w);
  },

  get ready() {
    return this.map.size > 0;
  },

  label(code) {
    return this.LABELS[code] || "устойчивое выражение";
  },

  // ---------- text parsing ----------
  _tokens(text) {
    const out = [];
    const re = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
    for (const m of String(text).matchAll(re)) {
      out.push({ w: m[0].toLowerCase().replace(/’/g, "'"), start: m.index, end: m.index + m[0].length });
    }
    return out;
  },

  _formsCache: new Map(),
  // Word variants for matching against expressions: the base form and pronoun "classes"
  _forms(w) {
    let f = this._formsCache.get(w);
    if (f) return f;
    f = [];
    const add = (x) => x && !f.includes(x) && f.push(x);
    if (/^(my|your|his|her|its|our|their|someone's|somebody's)$/.test(w)) add("one's");
    if (/^(me|him|them|us|you|it)$/.test(w)) add("someone");
    if (/^(myself|yourself|himself|herself|itself|ourselves|themselves|yourselves)$/.test(w)) add("oneself");
    if (this.vocab.has(w)) add(w);
    for (const c of Wordbook.Lemma.candidates(w).slice(1)) {
      if (this.vocab.has(c)) {
        add(c);
        break;
      }
    }
    add(w);
    if (this._formsCache.size > 20000) this._formsCache.clear();
    this._formsCache.set(w, f);
    return f;
  },

  // Looks for an expression that spans exactly tokens [i, j)
  _matchRange(tokens, i, j) {
    const parts = [];
    for (let k = i; k < j; k++) parts.push(this._forms(tokens[k].w));
    const rec = (idx, acc) => {
      if (idx === parts.length) {
        const key = acc.join(" ");
        return this.map.has(key) ? key : null;
      }
      for (const v of parts[idx]) {
        const r = rec(idx + 1, acc.concat(v));
        if (r) return r;
      }
      return null;
    };
    const key = rec(0, []);
    if (!key) return null;
    const [code, ru, gloss] = this.map.get(key);
    return {
      key,
      code,
      type: this.label(code),
      ru: ru || "",
      gloss: gloss || "",
      weak: code === "n",
      i,
      j,
      start: tokens[i].start,
      end: tokens[j - 1].end,
    };
  },

  // All expressions in the tokens (longer before shorter)
  _findAll(tokens) {
    const res = [];
    for (let n = Math.min(this.MAX_N, tokens.length); n >= 2; n--) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const m = this._matchRange(tokens, i, i + n);
        if (m) res.push(m);
      }
    }
    return res;
  },

  // Recognise the selection itself as a whole expression
  exact(selection) {
    if (!this.ready) return null;
    const t = this._tokens(selection);
    if (t.length < 2 || t.length > this.MAX_N) return null;
    return this._matchRange(t, 0, t.length);
  },

  analyze(selection, sentence) {
    const out = { exact: null, inside: [], context: [] };
    if (!this.ready) return out;
    const sel = this._tokens(selection);
    if (!sel.length) return out;

    out.exact = sel.length >= 2 && sel.length <= this.MAX_N ? this._matchRange(sel, 0, sel.length) : null;

    // inside the selection (except "weak" compound nouns)
    if (sel.length >= 3) {
      out.inside = this._findAll(sel).filter((m) => !m.weak && !(m.i === 0 && m.j === sel.length));
      out.inside = this._dedupe(out.inside).slice(0, 3);
    }

    // in the surrounding sentence
    if (sentence) {
      const st = this._tokens(sentence);
      const a = this._findSequence(st, sel);
      if (a >= 0) {
        const b = a + sel.length;
        out.context = this._dedupe(
          this._findAll(st).filter((m) => !m.weak && m.i < b && m.j > a && !(m.i >= a && m.j <= b))
        )
          .filter((m) => m.key !== out.exact?.key)
          .slice(0, 3);
      }
    }
    return out;
  },

  // Position of the token sequence sel in st (by normalised word forms)
  _findSequence(st, sel) {
    outer: for (let i = 0; i + sel.length <= st.length; i++) {
      for (let k = 0; k < sel.length; k++) {
        if (st[i + k].w !== sel[k].w) continue outer;
      }
      return i;
    }
    return -1;
  },

  // Removes expressions that lie entirely inside longer found ones
  _dedupe(list) {
    const res = [];
    for (const m of list) {
      if (!res.some((r) => r.key === m.key || (r.i <= m.i && r.j >= m.j && r.j - r.i > m.j - m.i))) res.push(m);
    }
    return res;
  },
};
