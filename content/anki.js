/* global Zotero, ChromeUtils, Wordbook */
// Export to Anki.
//  Main path: AnkiConnect (add-on 2055492159) at http://127.0.0.1:8765.
//  Fallback path: a TSV file for manual import (File → Import in Anki).
//
// Duplicate protection — two levels:
//  1) locally: after export the entry gets entry.anki and no longer enters the queue;
//  2) in Anki itself: addNotes with allowDuplicate:false. If the word is already there (for example,
//     added manually or from another Zotero installation), the note is not created and the entry
//     is marked as exported with anki.duplicate = true.
// The first note field (Word) is the normalized key, so "Run" and "run" count as the same word.

Wordbook.Anki = {
  async invoke(action, params = {}) {
    let resp;
    try {
      resp = await Zotero.HTTP.request("POST", Wordbook.getPref("ankiUrl"), {
        body: JSON.stringify({ action, version: 6, params }),
        headers: { "Content-Type": "application/json" },
        responseType: "json",
        timeout: 15000,
      });
    } catch (e) {
      throw new Error("Нет связи с Anki. Запустите Anki и установите аддон AnkiConnect (код 2055492159).");
    }
    const { result, error } = resp.response || {};
    if (error) throw new Error("AnkiConnect: " + error);
    return result;
  },

  // Connection check: returns the AnkiConnect API version
  async ping() {
    return this.invoke("version");
  },

  _FRONT: "{{Word}}",
  _BACK: "{{FrontSide}}<hr id=answer>{{Translation}}<br>{{Audio}}<br><small>{{Context}}</small><br><small>{{Source}}</small>",
  _CSS: ".card { font-family: system-ui, sans-serif; font-size: 22px; text-align: center; }",

  // Creates the deck and note type if they do not exist yet; in the old model (with a Definition field) adds Audio and removes Definition
  async ensureSetup() {
    const deck = Wordbook.getPref("ankiDeck");
    const model = Wordbook.getPref("ankiModel");
    await this.invoke("createDeck", { deck }); // idempotent

    const models = await this.invoke("modelNames");
    if (!models.includes(model)) {
      await this.invoke("createModel", {
        modelName: model,
        inOrderFields: ["Word", "Translation", "Context", "Audio", "Source"],
        css: this._CSS,
        cardTemplates: [{ Name: "Word → Translation", Front: this._FRONT, Back: this._BACK }],
      });
      return;
    }

    const fields = await this.invoke("modelFieldNames", { modelName: model });
    if (!fields.includes("Audio")) await this.invoke("modelFieldAdd", { modelName: model, fieldName: "Audio" });
    if (fields.includes("Definition")) {
      // first the template without {{Definition}}, then the field is removed; a failure here must not block the export
      try {
        const templates = await this.invoke("modelTemplates", { modelName: model });
        const name = Object.keys(templates || {})[0];
        if (name) {
          await this.invoke("updateModelTemplates", {
            model: { name: model, templates: { [name]: { Front: templates[name].Front, Back: this._BACK } } },
          });
        }
        await this.invoke("modelFieldRemove", { modelName: model, fieldName: "Definition" });
      } catch (e) {
        Wordbook.log("Не удалось убрать поле Definition: " + e.message); // the field will stay empty
      }
    }
  },

  _html(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  },

  _sourceLabel(entry) {
    const s = entry.source || {};
    return [s.title, s.page ? "p. " + s.page : ""].filter(Boolean).join(", ");
  },

  // ---------- context for the card ----------
  // Replaces the letters of the target word/expression in the sentence with «_» (word forms too: «appeared to», «Häuser»).
  // Returns null if the word could not be found in the sentence — then no context is given,
  // so as not to reveal the answer.
  maskSentence(sentence, entry) {
    const lang = entry.lang || "en";
    const word = entry.word || entry.key;
    const M = Wordbook.Morph;
    const maskRanges = (ranges) => {
      let out = "";
      let pos = 0;
      for (const r of ranges.sort((x, y) => x.start - y.start)) {
        if (r.start < pos) continue;
        out += sentence.slice(pos, r.start) + sentence.slice(r.start, r.end).replace(/\p{L}/gu, "_");
        pos = r.end;
      }
      return out + sentence.slice(pos);
    };
    const find = (words) => M.findAll(sentence, M.buildMatcher(words.map((w) => ({ id: w, word: w })), lang), lang);

    // 1) the whole expression, accounting for word forms
    let ranges = find([word]);
    if (ranges.length) return maskRanges(ranges);
    // 2) each word of the expression separately (a gap with an insertion: «turn it off» for «turn off»;
    //    «sich erinnern an» -> «erinnert sich ... an»)
    const words = M.tokens(word).map((t) => t.w).filter((w) => w.length > 1);
    ranges = find(words);
    // 3) irregular forms of English words: go -> went, gone
    if (lang === "en") {
      const forms = words.flatMap((w) => Wordbook.Lemma.formsOf(w)).filter((f) => /^[a-z]+$/.test(f));
      if (forms.length) ranges.push(...find(forms));
    }
    // 4) words with the same beginning (forms the stemmer did not reduce to one stem)
    for (const w of words) {
      if (w.length < 5) continue;
      const stem = w.slice(0, Math.max(3, w.length - 2)).toLowerCase();
      for (const t of M.tokens(sentence)) if (t.w.toLowerCase().startsWith(stem)) ranges.push({ start: t.s, end: t.e });
    }
    return ranges.length ? maskRanges(ranges) : null;
  },

  // Context field: the sentence where the word was first added (word masked) + a Russian translation.
  // The translation is online; without internet only the English sentence remains.
  async _contextField(entry, state) {
    const sentence = String(entry.context || "").replace(/\s+/g, " ").trim();
    if (!sentence) return { en: "", ru: "" };
    const en = this.maskSentence(sentence, entry);
    if (en === null) return { en: "", ru: "" };
    let ru = "";
    if (state.online) {
      try {
        ru = await Wordbook.Translator.translateSentence(sentence);
      } catch (e) {
        // no network, rate limit or key error — do not try further, so as not to wait for a timeout on every word
        if (["NETWORK", "RATE", "NO_KEY", "BAD_KEY", "PAYMENT", "NO_MODEL"].includes(e.code)) state.online = false;
        Wordbook.log("anki context translate: " + e.message);
      }
    }
    return { en, ru };
  },

  async _contexts(entries) {
    const state = { online: !!Wordbook.Translator?.onlineEnabled };
    const out = new Map();
    for (const e of entries) out.set(e.key, await this._contextField(e, state));
    return out;
  },

  _contextHtml(ctx) {
    return [this._html(ctx.en), ctx.ru ? `<i>${this._html(ctx.ru)}</i>` : ""].filter(Boolean).join("<br>");
  },

  // Words exported earlier (versions without context): fill in the Context field of notes created by the plugin
  async _syncContexts(summary) {
    const todo = Wordbook.Store.all().filter(
      (e) => e.anki?.noteId && !e.anki.duplicate && !e.anki.contextSynced && String(e.context || "").trim()
    );
    if (!todo.length) return;
    const ctxs = await this._contexts(todo);
    for (const e of todo) {
      const c = ctxs.get(e.key);
      if (!c?.en) continue;
      try {
        await this.invoke("updateNoteFields", { note: { id: e.anki.noteId, fields: { Context: this._contextHtml(c) } } });
        Wordbook.Store.markContextSynced(e.key);
        summary.updated++;
      } catch (err) {
        Wordbook.log("updateNoteFields: " + err.message);
      }
    }
  },

  _toNote(entry, ctx = { en: "", ru: "" }) {
    return {
      deckName: Wordbook.getPref("ankiDeck"),
      modelName: Wordbook.getPref("ankiModel"),
      fields: {
        Word: this._html(entry.word || entry.key),
        Translation: this._html(entry.translation),
        Context: this._contextHtml(ctx),
        Audio: "", // stays empty: the user fills it in
        Source: this._html(this._sourceLabel(entry)),
      },
      options: { allowDuplicate: false },
      tags: ["zotero-wordbook", `lang-${entry.lang || "en"}-${entry.dst || "ru"}`, ...(entry.idiom ? ["idiom"] : [])],
    };
  },

  // Anki search special characters: \ " * _ :
  _q(s) {
    return String(s).replace(/([\\"*_:])/g, "\\$1");
  },

  async _findExisting(key) {
    const model = Wordbook.getPref("ankiModel");
    const ids = await this.invoke("findNotes", {
      query: `"note:${this._q(model)}" "Word:${this._q(key)}"`,
    });
    return ids?.[0] ?? null;
  },

  // Export all words not yet exported. Returns { total, added, duplicates, failed }
  async exportPending() {
    const entries = Wordbook.Store.pendingAnki();
    const summary = { total: entries.length, added: 0, duplicates: 0, failed: 0, updated: 0, noContext: 0 };
    const needSync = Wordbook.Store.all().some((e) => e.anki?.noteId && !e.anki.duplicate && !e.anki.contextSynced && e.context);
    if (!entries.length && !needSync) return summary;

    await this.ensureSetup();
    await this._syncContexts(summary);
    if (!entries.length) return summary;
    summary.noContext = entries.filter((e) => !String(e.context || "").trim()).length;
    const ctxs = await this._contexts(entries);
    const ids = await this.invoke("addNotes", { notes: entries.map((e) => this._toNote(e, ctxs.get(e.key))) });

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (ids[i]) {
        Wordbook.Store.markExported(entry.key, ids[i]);
        summary.added++;
        continue;
      }
      // null => Anki refused (most likely a duplicate): look for the existing note
      const existing = await this._findExisting(entry.word || entry.key);
      if (existing) {
        Wordbook.Store.markExported(entry.key, existing, { duplicate: true });
        summary.duplicates++;
      } else {
        summary.failed++;
      }
    }
    return summary;
  },

  // ---------- fallback path: TSV ----------
  toTsv(entries, ctxs = new Map()) {
    const cell = (s) => String(s ?? "").replace(/[\t\r\n]+/g, " ");
    const lines = [
      "#separator:tab",
      "#html:false",
      "#notetype:" + Wordbook.getPref("ankiModel"),
      "#deck:" + Wordbook.getPref("ankiDeck"),
      "#tags column:5",
    ];
    for (const e of entries) {
      lines.push(
        [e.word || e.key, e.translation, [ctxs.get(e.key)?.en, ctxs.get(e.key)?.ru].filter(Boolean).join(" — "), this._sourceLabel(e), "zotero-wordbook"].map(cell).join("\t")
      );
    }
    return lines.join("\n") + "\n";
  },

  // Saves a TSV with all words not yet exported. Anki will filter out duplicates on import by the first field.
  async exportTsv(window) {
    const entries = Wordbook.Store.pendingAnki();
    if (!entries.length) return null;

    const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const fp = new FilePicker();
    fp.init(window, "Сохранить TSV для Anki", fp.modeSave);
    fp.appendFilters(fp.filterAll);
    fp.defaultString = "wordbook.tsv";
    const rv = await fp.show();
    if (rv !== fp.returnOK && rv !== fp.returnReplace) return null;

    await Zotero.File.putContentsAsync(fp.file, this.toTsv(entries, await this._contexts(entries)));
    for (const e of entries) Wordbook.Store.markExported(e.key, null);
    return { count: entries.length, path: fp.file };
  },
};
