/* global Zotero, Wordbook */
// Translation of the selected word/expression. Two layers:
//
//  1) offline(text)  — synchronous, no network: a list of expressions (with Russian equivalents) +
//     the built-in EN→RU dictionary (+ a StarDict dictionary, if the user has loaded one).
//  2) online(text, context) — optional, if an API key is set: a language model (Gemini or
//     any OpenAI-compatible service, e.g. DeepSeek) translates taking the sentence into account and
//     reports whether the selection is an idiom or a fixed expression.
//
// The popover first shows the offline result instantly, then replaces it with the online answer.
// If there is no network or the service returned an error, the offline result stays.

var STOP = new Set(
  "a an the of to in on at for and or but is are was were be been being it its this that these those " +
    "with by from as not no so if than then there their they he she we you i his her our your my me him them us " +
    "do does did has have had will would can could may might shall should which who whom whose what when where why how".split(" ")
);

var DEFAULTS = {
  free: { label: "Google Translate" },
  gemini: { model: "gemini-flash-latest", label: "Gemini" }, // «latest» is an alias for the current Flash model
  openai: { model: "deepseek-flash", baseUrl: "https://api.deepseek.com", label: "DeepSeek / OpenAI-совместимый" },
  // OpenRouter: one key, free models available (the free-tier limit is enforced by the service)
  openrouter: { model: "meta-llama/llama-3.3-70b-instruct:free", baseUrl: "https://openrouter.ai/api/v1", label: "OpenRouter" },
};

// Errors for which we show the free Google translation instead of the model's answer
var FALLBACK_CODES = ["NETWORK", "REGION", "BAD_KEY", "RATE", "PAYMENT", "NO_MODEL", "HTTP", "EMPTY"];

Wordbook.Translator = {
  _cache: new Map(), // "text|context" -> Promise<online result>

  // ====================== offline ======================
  // Returns { text, alternatives, definition, headword, form, source }
  // Errors: DICT_EMPTY | NOT_FOUND (NOT_FOUND has e.hints — translations of the individual words)
  // The offline dictionary and idiom database exist only for English -> Russian
  get offlineSupported() {
    const { src, dst } = Wordbook.langs();
    return src === "en" && dst === "ru";
  },

  offline(text) {
    if (!this.offlineSupported) {
      const e = new Error("Для этой пары языков нет офлайн-словаря");
      e.code = "NO_OFFLINE";
      throw e;
    }
    // 1. the whole selection is a known expression with a Russian equivalent
    const idi = Wordbook.Idioms?.exact(text);
    if (idi?.ru) {
      const parts = idi.ru.split(/,\s*/);
      return {
        text: parts.slice(0, 3).join(", "),
        alternatives: parts.slice(3, 6),
        definition: idi.gloss ? `${idi.type}. ${idi.gloss}` : idi.type,
        headword: idi.key,
        form: "idiom",
        source: "idioms",
      };
    }

    if (!Wordbook.Dict.ready) {
      const e = new Error("Словарь не загружен");
      e.code = "DICT_EMPTY";
      throw e;
    }
    const hit = Wordbook.Dict.lookup(text);
    if (!hit) {
      const e = new Error("Слова нет в словаре");
      e.code = "NOT_FOUND";
      e.hints = this.wordHints(text);
      throw e;
    }

    if (hit.source === "basic") {
      const items = hit.items;
      const n = items.some((x) => x.includes(" / ")) ? 2 : 3; // verb-aspect pairs are long — show fewer
      return {
        text: items.slice(0, n).join(", "),
        alternatives: items.slice(n, n + 4),
        definition: "",
        headword: hit.headword,
        form: hit.form,
        source: "basic",
      };
    }
    // StarDict dictionary loaded by the user (e.g. Mueller)
    const { first, other } = Wordbook.Dict.glosses(hit.text, hit.form);
    const n = hit.form === "phrase" ? 2 : 3;
    return {
      text: first.slice(0, n).join(", ") || hit.text.split("\n").find((l) => /[а-яё]/i.test(l))?.trim().slice(0, 80) || "",
      alternatives: [...first.slice(n), ...other].slice(0, 4),
      definition: hit.text.length > 1500 ? hit.text.slice(0, 1500) + "…" : hit.text,
      headword: hit.headword,
      form: hit.form,
      source: "user",
    };
  },

  // Hints for the individual words of a phrase that is not in the dictionary
  wordHints(text) {
    const hints = [];
    for (const w of String(text).toLowerCase().match(/[a-z']+/g) || []) {
      if (STOP.has(w) || hints.some((h) => h.word === w)) continue;
      const hit = Wordbook.Dict.lookup(w);
      if (!hit) continue;
      const items = hit.items || Wordbook.Dict.glosses(hit.text).first;
      if (items?.length) hints.push({ word: w, gloss: items.slice(0, 2).join(", ") });
      if (hints.length >= 5) break;
    }
    return hints;
  },

  // ====================== online ======================
  get provider() {
    const p = Wordbook.getPref("llmProvider");
    if (p === "openai" || p === "gemini" || p === "openrouter" || p === "off") return p;
    // the user pasted a Gemini key but forgot to choose a service — use Gemini
    if (/^(AIza|AQ\.)/.test(String(Wordbook.getPref("llmKey") || "").trim())) return "gemini";
    return "free";
  },

  // free — free Google Translate without a key; gemini/openai — an API key is required; off — offline only
  get onlineEnabled() {
    const p = this.provider;
    if (p === "off") return false;
    if (p === "free") return true;
    return !!String(Wordbook.getPref("llmKey") || "").trim();
  },

  get providerLabel() {
    return DEFAULTS[this.provider].label;
  },

  _model() {
    return String(Wordbook.getPref("llmModel") || "").trim() || DEFAULTS[this.provider].model;
  },

  _systemPrompt() {
    const N = { en: "English", ru: "Russian" };
    const { src, dst } = Wordbook.langs();
    const S = N[src];
    const D = N[dst];
    return [
      `You are an expert ${S}-to-${D} translator and lexicographer helping a reader of ${S} academic and non-fiction texts who reads in ${D}.`,
      "The user sends JSON: {\"selection\": the exact words the reader highlighted, \"sentence\": the sentence it appears in (may be empty)}.",
      "Reply with ONLY a JSON object, no markdown, with these keys:",
      "  \"translation\": the most accurate " + D + " translation of the selection AS USED in this sentence. For one word give 1-3 close " + D + " words IN DICTIONARY FORM (" + D + " nouns in nominative singular, adjectives in nominative singular masculine, verbs in the infinitive) even if the sentence requires a plural, a case or a tense: the sentence only decides which sense to choose, the reader will save this word in a dictionary; for an expression give a natural " + D + " equivalent (not word-for-word). Never translate the whole sentence unless the selection is the whole sentence.",
      "  \"alternatives\": up to 3 other genuinely different " + D + " renderings or senses (array of short strings; may be empty).",
      "  \"is_fixed_expression\": true if the selection IS, or is a part of, an idiom, phrasal verb, proverb or a stable collocation in this sentence; otherwise false.",
      "  \"expression_type\": one of \"idiom\", \"phrasal_verb\", \"proverb\", \"collocation\", \"none\".",
      "  \"expression\": the full expression in its dictionary form (e.g. \"trace back to\") when is_fixed_expression is true, else \"\".",
      "  \"explanation\": 1-2 short sentences in " + D + ": the meaning and, for idioms, the figurative meaning versus the literal one; mention register or nuance only if important.",
      "  \"lemma\": dictionary form of the selection.",
      "Be precise. Do not invent idioms: mark is_fixed_expression true only if the phrase really is a established fixed expression.",
    ].join("\n");
  },

  _parse(raw) {
    let t = String(raw || "").trim();
    t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try {
      return JSON.parse(t);
    } catch (e) {
      const m = t.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw new Error("Модель вернула ответ не в формате JSON");
    }
  },

  _normalize(obj) {
    const str = (v) => (typeof v === "string" ? v.trim() : "");
    const type = str(obj.expression_type);
    const fixed = obj.is_fixed_expression === true && type !== "none";
    return {
      text: str(obj.translation),
      alternatives: (Array.isArray(obj.alternatives) ? obj.alternatives : [])
        .map(str)
        .filter((x) => x && x.toLowerCase() !== str(obj.translation).toLowerCase())
        .slice(0, 3),
      isIdiom: fixed,
      expressionType: fixed ? type : "none",
      expression: fixed ? str(obj.expression) : "",
      explanation: str(obj.explanation),
      lemma: str(obj.lemma),
      provider: this.providerLabel,
    };
  },

  // Translation of a whole sentence (for Anki cards). Throws if online is disabled or unavailable.
  async translateSentence(sentence) {
    const r = await this.translatePassage(String(sentence).slice(0, 1500));
    return r.text;
  },

  // ====================== fragment translation (sentence, paragraph) ======================
  // ctx = { before, after } — the surrounding page text: the model uses it only to
  // understand the meaning (pronouns, terms, word senses) and does not translate it.
  translatePassage(text, ctx = {}) {
    if (!this.onlineEnabled) {
      const e = new Error("Перевод фрагментов работает только онлайн");
      e.code = "NO_KEY";
      return Promise.reject(e);
    }
    const { src, dst } = Wordbook.langs();
    const before = ctx.before || "";
    const after = ctx.after || "";
    const key = `P|${this.provider}|${this._model()}|${src}-${dst}|${before}|${text}|${after}`;
    if (this._cache.has(key)) return this._cache.get(key);
    const p = this._requestPassage(text, before, after).catch((e) => {
      this._cache.delete(key);
      throw e;
    });
    this._cache.set(key, p);
    return p;
  },

  _passagePrompt() {
    const N = { en: "English", ru: "Russian" };
    const { src, dst } = Wordbook.langs();
    return [
      `You are a professional ${N[src]}-to-${N[dst]} translator with the skill of a literary and academic translator.`,
      `Translate the text inside <text> into ${N[dst]}.`,
      "Requirements:",
      "- Convey the exact meaning completely: no omissions, no additions, no summarizing.",
      `- Write natural, idiomatic ${N[dst]} that reads like an original text, not a word-for-word rendering; follow the target language's word order, punctuation and style.`,
      "- Keep the author's tone, register, style, rhythm and logical structure. Keep terminology consistent.",
      "- Render idioms, metaphors, irony, wordplay and cultural references through their closest natural equivalents, not literally.",
      "- Keep proper names; transliterate or use the established target-language form where one exists.",
      "- <context_before> and <context_after> (if present) are the surrounding text. Use them ONLY to resolve ambiguity (pronoun reference, word sense, terminology, tense, grammatical gender). Never translate them.",
      "- The text was copied from a PDF: silently repair broken hyphenation and stray line breaks. Keep real paragraph breaks.",
      "- Output ONLY the translation: no notes, no explanations, no quotes, no tags, no preface.",
    ].join("\n");
  },

  async _requestPassage(text, before, after) {
    if (this.provider === "free") return this._freePassage(text);
    try {
      return await this._requestPassageLlm(text, before, after);
    } catch (e) {
      if (!FALLBACK_CODES.includes(e.code)) throw e;
      const res = await this._freePassage(text);
      res.fallbackReason = `${this.providerLabel}: ${e.message}`;
      return res;
    }
  },

  async _requestPassageLlm(text, before, after) {
    const user =
      (before ? `<context_before>\n${before}\n</context_before>\n\n` : "") +
      `<text>\n${text}\n</text>` +
      (after ? `\n\n<context_after>\n${after}\n</context_after>` : "");
    const o = { system: this._passagePrompt(), json: false, timeout: 90000 };
    const raw = this.provider === "gemini" ? await this._gemini(user, false, o) : await this._openai(user, o);
    const out = String(raw)
      .replace(/^\s*```[a-z]*\n?|\n?```\s*$/gi, "")
      .replace(/^\s*<text>\s*|\s*<\/text>\s*$/gi, "")
      .trim();
    if (!out) throw this._fail("EMPTY", "Модель не вернула перевод");
    return { text: out, alternatives: [], provider: this.providerLabel, contextual: true };
  },

  // Google Translate: split long text into chunks by paragraphs and sentences (up to ~3500 characters) and go through them in order
  async _googlePassage(text) {
    const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const out = [];
    for (const para of paragraphs) {
      const parts = [];
      let cur = "";
      for (const sent of para.split(/(?<=[.!?…]["'”’)\]]*)\s+/)) {
        if (cur && cur.length + sent.length + 1 > 3500) {
          parts.push(cur);
          cur = "";
        }
        cur += (cur ? " " : "") + sent;
      }
      if (cur) parts.push(cur);
      const tr = [];
      for (const chunk of parts) tr.push(await this._googleChunk(chunk));
      out.push(tr.join(" "));
    }
    const result = out.join("\n\n").trim();
    if (!result) throw this._fail("EMPTY", "Пустой ответ сервиса");
    return { text: result, alternatives: [], provider: DEFAULTS.free.label, contextual: false };
  },

  async _googleChunk(chunk) {
    const { src, dst } = Wordbook.langs();
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=${encodeURIComponent(src)}&tl=${encodeURIComponent(dst)}`;
    let resp;
    try {
      resp = await Zotero.HTTP.request("POST", url, {
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: "q=" + encodeURIComponent(chunk),
        responseType: "json",
        timeout: 20000,
        successCodes: false,
      });
    } catch (e) {
      throw this._fail("NETWORK", "Нет связи с сервисом");
    }
    if (resp.status === 429) throw this._fail("RATE", "Сервис временно ограничил запросы, попробуйте позже");
    if (resp.status !== 200 || !Array.isArray(resp.response)) throw this._fail("HTTP", `Ошибка сервиса (${resp.status})`);
    return (Array.isArray(resp.response[0]) ? resp.response[0] : []).map((seg) => (Array.isArray(seg) ? seg[0] || "" : "")).join("").trim();
  },

  // Translation taking context into account. Results are cached for the duration of the session.
  online(text, context = "") {
    if (!this.onlineEnabled) {
      const e = new Error("Не указан ключ API");
      e.code = "NO_KEY";
      return Promise.reject(e);
    }
    const { src, dst } = Wordbook.langs();
    const key = `${this.provider}|${this._model()}|${src}-${dst}|${Wordbook.normalize(text)}|${context}`;
    if (this._cache.has(key)) return this._cache.get(key);
    const p = this._request(text, context).catch((e) => {
      this._cache.delete(key); // do not cache errors
      throw e;
    });
    this._cache.set(key, p);
    return p;
  },

  // strict = true: no fallback Google translation (for the «Check connection» button)
  async _request(text, context, retried = false, strict = false) {
    if (this.provider === "free") return this._freeWord(text, context);
    try {
      const user = JSON.stringify({ selection: text, sentence: context || "" });
      const raw = this.provider === "gemini" ? await this._gemini(user, retried) : await this._openai(user);
      const res = this._normalize(this._parse(raw));
      res.contextual = true;
      if (!res.text) throw this._fail("EMPTY", "Пустой ответ модели");
      return res;
    } catch (e) {
      if (strict || !FALLBACK_CODES.includes(e.code)) throw e;
      // the selected service is unavailable — don't leave the user without a translation: use free Google Translate
      const res = await this._freeWord(text, context);
      res.fallbackReason = res.fallbackReason ? `${this.providerLabel}: ${e.message}; ${res.fallbackReason}` : `${this.providerLabel}: ${e.message}`;
      return res;
    }
  },

  // ---- Free services without a key: Google Translate, falling back to Microsoft Translator (as in Microsoft Edge) ----
  async _freeWord(text, context) {
    try {
      return await this._googleInContext(text, context);
    } catch (e) {
      if (!FALLBACK_CODES.includes(e.code)) throw e;
      try {
        const res = await this._edgeInContext(text, context);
        res.fallbackReason = `Google Translate: ${e.message}`;
        return res;
      } catch (e2) {
        throw e; // both services are unavailable — show the original error
      }
    }
  },

  async _freePassage(text) {
    try {
      return await this._googlePassage(text);
    } catch (e) {
      if (!FALLBACK_CODES.includes(e.code)) throw e;
      try {
        const res = await this._edgePassage(text);
        res.fallbackReason = `Google Translate: ${e.message}`;
        return res;
      } catch (e2) {
        throw e;
      }
    }
  },

  // Microsoft Translator via Edge's public access: a short-lived token is obtained without a key and lives ~10 minutes
  _edgeToken: null,
  _edgeTokenAt: 0,
  async _edgeAuth(force = false) {
    if (!force && this._edgeToken && Date.now() - this._edgeTokenAt < 8 * 60 * 1000) return this._edgeToken;
    let resp;
    try {
      resp = await Zotero.HTTP.request("GET", "https://edge.microsoft.com/translate/auth", { responseType: "text", timeout: 8000, successCodes: false });
    } catch (e) {
      throw this._fail("NETWORK", "Нет связи с сервисом");
    }
    const tok = String(resp.responseText || resp.response || "").trim();
    if (resp.status !== 200 || tok.length < 20) throw this._fail("HTTP", `Ошибка сервиса (${resp.status})`);
    this._edgeToken = tok;
    this._edgeTokenAt = Date.now();
    return tok;
  },

  // texts — an array of strings, returns an array of translations
  async _edgeRaw(texts, retried = false) {
    const { src, dst } = Wordbook.langs();
    const token = await this._edgeAuth(retried);
    const url = `https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&from=${encodeURIComponent(src)}&to=${encodeURIComponent(dst)}`;
    let resp;
    try {
      resp = await Zotero.HTTP.request("POST", url, {
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(texts.map((t) => ({ Text: t }))),
        responseType: "json",
        timeout: 15000,
        successCodes: false,
      });
    } catch (e) {
      throw this._fail("NETWORK", "Нет связи с сервисом");
    }
    if (resp.status === 401 && !retried) return this._edgeRaw(texts, true); // the token has expired
    if (resp.status === 429) throw this._fail("RATE", "Сервис временно ограничил запросы, попробуйте позже");
    if (resp.status !== 200 || !Array.isArray(resp.response)) throw this._fail("HTTP", `Ошибка сервиса (${resp.status})`);
    return resp.response.map((r) => String(r?.translations?.[0]?.text || "").trim());
  },

  async _edgeInContext(text, context) {
    const result = (t, ctxual) => ({
      text: t,
      alternatives: [],
      isIdiom: false,
      expressionType: "none",
      expression: "",
      explanation: "",
      lemma: "",
      provider: "Microsoft Translator",
      contextual: ctxual,
    });
    const ctx = String(context || "").replace(/\s+/g, " ").trim();
    const at = ctx.toLowerCase().indexOf(String(text).toLowerCase());
    if (ctx && at >= 0 && ctx.length <= 500) {
      try {
        const marked = ctx.slice(0, at) + "[" + ctx.slice(at, at + text.length) + "]" + ctx.slice(at + text.length);
        const [out] = await this._edgeRaw([marked]);
        const t = this._pickMarked(out, text);
        if (t) return result(t, true);
      } catch (e) {
        // the sentence approach failed — translate the word separately
      }
    }
    const [one] = await this._edgeRaw([String(text)]);
    if (!one) throw this._fail("EMPTY", "Пустой ответ сервиса");
    const { dst } = Wordbook.langs();
    return result(dst === "ru" && !/\s/.test(one) && !/\s/.test(String(text).trim()) ? Wordbook.Lemma.ruDictForm(one) : one, false);
  },

  async _edgePassage(text) {
    const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const out = [];
    for (const para of paragraphs) {
      const parts = [];
      let cur = "";
      for (const sent of para.split(/(?<=[.!?…]["'”’)\]]*)\s+/)) {
        if (cur && cur.length + sent.length + 1 > 2500) {
          parts.push(cur);
          cur = "";
        }
        cur += (cur ? " " : "") + sent;
      }
      if (cur) parts.push(cur);
      out.push((await this._edgeRaw(parts)).join(" "));
    }
    const result = out.join("\n\n").trim();
    if (!result) throw this._fail("EMPTY", "Пустой ответ сервиса");
    return { text: result, alternatives: [], provider: "Microsoft Translator", contextual: false };
  },

  // From a translation of a sentence with brackets, extracts the translation of the word: "...[обиделся]..." -> "обиделся"
  _pickMarked(out, text) {
    const m = String(out || "").match(/\[\s*([^\[\]]{1,80}?)\s*\]/);
    let t = m ? m[1].replace(/^[\s.,;:!?«»"“”-]+|[\s.,;:!?«»"“”-]+$/g, "") : "";
    const limit = Math.max(3, String(text).trim().split(/\s+/).length * 2 + 1);
    if (!t || t.split(/\s+/).length > limit) return "";
    if (/^[a-zа-яё]/.test(String(text)) && /^[A-ZА-ЯЁ]/.test(t) && !/^[A-ZА-ЯЁ]{2}/.test(t)) t = t[0].toLowerCase() + t.slice(1);
    const { dst } = Wordbook.langs();
    if (dst === "ru" && !/\s/.test(t) && !/\s/.test(String(text).trim())) t = Wordbook.Lemma.ruDictForm(t);
    return t;
  },

  // Google Translate by sentence: the word is put in square brackets within the sentence, the whole sentence is translated,
  // and whatever ended up in the brackets is extracted from the translation — this accounts for the word's meaning in this particular place.
  // Part-of-speech variants come from a separate single-word request. If that fails, a plain word translation is used.
  async _googleInContext(text, context) {
    const ctx = String(context || "").replace(/\s+/g, " ").trim();
    const at = ctx.toLowerCase().indexOf(String(text).toLowerCase());
    if (!ctx || at < 0 || ctx.length > 500) return this._google(text);
    // both requests run simultaneously: the word translation is the fallback and the source of alternatives
    const marked = ctx.slice(0, at) + "[" + ctx.slice(at, at + text.length) + "]" + ctx.slice(at + text.length);
    const dst = Wordbook.langs().dst;
    const pOut = this._googleRaw(marked).catch(() => "");
    const word = await this._google(text);
    try {
      const out = await pOut;
      const m = out.match(/\[\s*([^\[\]]{1,80}?)\s*\]/);
      let t = m ? m[1].replace(/^[\s.,;:!?«»"“”-]+|[\s.,;:!?«»"“”-]+$/g, "") : "";
      // the in-context translation is in sentence form («некачественные»): for a single word we need the dictionary form
      if (dst === "ru" && !/\s/.test(t) && !/\s/.test(String(text).trim())) t = Wordbook.Lemma.ruDictForm(t);
      const limit = Math.max(3, String(text).trim().split(/\s+/).length * 2 + 1);
      if (!t || t.split(/\s+/).length > limit) return word;
      if (/^[a-zа-яё]/.test(String(text)) && /^[A-ZА-ЯЁ]/.test(t) && !/^[A-ZА-ЯЁ]{2}/.test(t)) t = t[0].toLowerCase() + t.slice(1);
      const alternatives = word.alternatives.filter((x) => x && x.toLowerCase() !== t.toLowerCase()).slice(0, 5);
      return { ...word, text: t, alternatives, contextual: true };
    } catch (e) {
      return word;
    }
  },

  // ---- Free Google Translate (no key, unofficial endpoint) ----
  // Translates the selected fragment without taking the sentence into account; for single words it also returns
  // variants by part of speech. Idioms and explanations are not detected here (the offline database does that).
  // GET to Google with one retry on a network error or a 5xx response (transient failures are frequent)
  async _gget(url) {
    let last;
    for (let i = 0; i < 2; i++) {
      try {
        const resp = await Zotero.HTTP.request("GET", url, { responseType: "json", timeout: 8000, successCodes: false });
        if (resp.status < 500) return resp;
        last = resp;
      } catch (e) {
        last = null;
      }
    }
    if (!last) throw this._fail("NETWORK", "Нет связи с сервисом");
    return last;
  },

  async _googleRaw(text) {
    const { src, dst } = Wordbook.langs();
    const url = "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=" + encodeURIComponent(src) + "&tl=" + encodeURIComponent(dst) + "&q=" + encodeURIComponent(text);
    const resp = await this._gget(url);
    if (resp.status !== 200 || !Array.isArray(resp.response)) throw this._fail("HTTP", `Ошибка сервиса (${resp.status})`);
    return (Array.isArray(resp.response[0]) ? resp.response[0] : []).map((seg) => (Array.isArray(seg) ? seg[0] || "" : "")).join("").trim();
  },

  async _google(text) {
    const { src, dst } = Wordbook.langs();
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&dt=bd&sl=" +
      encodeURIComponent(src) + "&tl=" + encodeURIComponent(dst) + "&q=" + encodeURIComponent(text);
    const resp = await this._gget(url);
    if (resp.status === 429) throw this._fail("RATE", "Сервис временно ограничил запросы, попробуйте позже");
    if (resp.status !== 200 || !Array.isArray(resp.response)) {
      throw this._fail("HTTP", `Ошибка сервиса (${resp.status})`);
    }
    const data = resp.response;
    const main = (Array.isArray(data[0]) ? data[0] : []).map((seg) => (Array.isArray(seg) ? seg[0] || "" : "")).join("").trim();
    if (!main) throw this._fail("EMPTY", "Пустой ответ сервиса");

    const alternatives = [];
    const seen = new Set([main.toLowerCase()]);
    for (const group of Array.isArray(data[1]) ? data[1] : []) {
      for (const term of Array.isArray(group?.[1]) ? group[1] : []) {
        const t = String(term).trim();
        if (t && !seen.has(t.toLowerCase())) {
          seen.add(t.toLowerCase());
          alternatives.push(t);
        }
      }
      if (alternatives.length >= 5) break;
    }
    return {
      text: main,
      alternatives: alternatives.slice(0, 5),
      isIdiom: false,
      expressionType: "none",
      expression: "",
      explanation: "",
      lemma: "",
      provider: DEFAULTS.free.label,
      contextual: false,
    };
  },

  _fail(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  },

  _httpError(status, body, hint) {
    const msg = body?.error?.message || body?.message || "";
    if (/location is not supported|not available in your (country|region)|region.*not supported/i.test(msg)) {
      return this._fail("REGION", "Сервис недоступен из вашего региона (Google ограничивает Gemini API в ряде стран). Нужен VPN или другой сервис, например OpenRouter.");
    }
    if (status === 401 || status === 403 || /api key not valid|invalid api key|incorrect api key/i.test(msg)) {
      return this._fail("BAD_KEY", "Неверный ключ API или нет доступа");
    }
    if (status === 429) return this._fail("RATE", "Превышен лимит запросов сервиса");
    if (status === 402) return this._fail("PAYMENT", "На счёте сервиса нет средств");
    if (status === 404) return this._fail("NO_MODEL", "Модель не найдена: " + (hint || ""));
    return this._fail("HTTP", `Ошибка сервиса (${status})${msg ? ": " + msg.slice(0, 120) : ""}`);
  },

  async _post(url, headers, body, timeout = 45000) {
    let resp;
    try {
      resp = await Zotero.HTTP.request("POST", url, {
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        responseType: "json",
        timeout,
        successCodes: false, // we handle the statuses ourselves
      });
    } catch (e) {
      Wordbook.log("network: " + (e?.message || e));
      throw this._fail("NETWORK", "Нет связи с сервисом (" + String(e?.message || e).slice(0, 80) + ")");
    }
    return resp;
  },

  // ---- Gemini ----
  async _gemini(user, retried, o = {}) {
    const model = this._model();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const headers = { "x-goog-api-key": String(Wordbook.getPref("llmKey")).trim() };
    const base = o.json === false ? { temperature: 0.3 } : { temperature: 0.2, responseMimeType: "application/json" };
    // Gemini 3 models «think» at a high level by default — a translation takes tens of seconds.
    // We ask for minimal reasoning; if the model does not recognise that setting (400), try another format, then none at all.
    const attempts = [{ thinkingLevel: "low" }, { thinkingBudget: 0 }, null];
    let resp;
    for (const thinking of attempts) {
      resp = await this._post(
        url,
        headers,
        {
          systemInstruction: { parts: [{ text: o.system || this._systemPrompt() }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: thinking ? { ...base, thinkingConfig: thinking } : base,
        },
        o.timeout || 60000
      );
      if (resp.status === 400 && thinking && /thinking/i.test(JSON.stringify(resp.response || ""))) continue;
      break;
    }
    if (resp.status === 404 && !retried && !Wordbook.getPref("llmModel")) {
      // the default model from the settings is outdated — pick the current Flash model
      const found = await this._pickGeminiModel();
      if (found) {
        Wordbook.setPref("llmModel", found);
        return this._gemini(user, true, o);
      }
    }
    if (resp.status !== 200) throw this._httpError(resp.status, resp.response, model);
    const parts = resp.response?.candidates?.[0]?.content?.parts || [];
    const out = parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
    if (!out) throw this._fail("EMPTY", "Модель не вернула ответ (возможно, сработал фильтр)");
    return out;
  },

  async _pickGeminiModel() {
    try {
      const resp = await Zotero.HTTP.request("GET", "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
        headers: { "x-goog-api-key": String(Wordbook.getPref("llmKey")).trim() },
        responseType: "json",
        timeout: 15000,
        successCodes: false,
      });
      const models = (resp.response?.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => String(m.name).replace(/^models\//, ""))
        .filter((n) => /^gemini-[\d.]+-flash(-preview[\w-]*)?$/.test(n) && !/lite|image|tts|live|audio/.test(n));
      const ver = (n) => parseFloat(n.match(/[\d.]+/)[0]);
      models.sort((a, b) => ver(b) - ver(a) || (/preview/.test(a) ? 1 : 0) - (/preview/.test(b) ? 1 : 0));
      return models[0] || null;
    } catch (e) {
      return null;
    }
  },

  // ---- OpenAI-compatible (DeepSeek, OpenAI, OpenRouter, local servers) ----
  async _openai(user, o = {}) {
    const base = (
      this.provider === "openrouter" ? DEFAULTS.openrouter.baseUrl : String(Wordbook.getPref("llmBaseUrl") || "").trim() || DEFAULTS.openai.baseUrl
    ).replace(/\/+$/, "");
    const headers = { Authorization: "Bearer " + String(Wordbook.getPref("llmKey")).trim() };
    const body = {
      model: this._model(),
      temperature: o.json === false ? 0.3 : 0.2,
      messages: [
        { role: "system", content: o.system || this._systemPrompt() },
        { role: "user", content: user },
      ],
    };
    if (o.json !== false) body.response_format = { type: "json_object" };
    let resp = await this._post(base + "/chat/completions", headers, body, o.timeout);
    if (resp.status === 400 && body.response_format && /response_format|json/i.test(JSON.stringify(resp.response || ""))) {
      delete body.response_format; // not all services support JSON mode
      resp = await this._post(base + "/chat/completions", headers, body, o.timeout);
    }
    if (resp.status !== 200) throw this._httpError(resp.status, resp.response, body.model);
    const out = resp.response?.choices?.[0]?.message?.content;
    if (!out) throw this._fail("EMPTY", "Модель не вернула ответ");
    return out;
  },

  // For the «Check» button in the settings
  async test() {
    try {
      const SAMPLE = { en: ["break the ice", "She told a joke to break the ice at the meeting."], ru: ["разбить лёд", "Он рассказал шутку, чтобы разбить лёд."] };
      const [word, sentence] = SAMPLE[Wordbook.langs().src];
      const r = await this._request(word, sentence, false, true);
      return { ok: true, message: `Работает: «${r.text}» (${this.providerLabel}${this.provider === "free" ? "" : ", " + this._model()})` };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  },
};
