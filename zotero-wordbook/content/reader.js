/* global Zotero, Wordbook */
// Integration with the Zotero reader (PDF only for highlighting; the popover works everywhere).
//
//  1) renderTextSelectionPopup — translation and the «＋ В словарь» button in the selection popover.
//  2) renderToolbar — the 📖 «open dictionary» button in the reader's top bar; it is also
//     the signal that «a reader is open», on which highlighting gets attached.
//
// IMPORTANT about the popover: Zotero calls our handler on EVERY re-render of the popover and
// clears the container every time. So the state (translation, status) is stored separately
// in this._popup, and the DOM is built from it synchronously — no flicker and no repeated requests.
//
// Internal fields (reader._internalReader._primaryView, reader._initPromise,
// Zotero.Reader._readers) are undocumented: see «Risks» in the README.

Wordbook.Reader = {
  _states: new Map(), // reader -> { alive, view }
  _popup: null,
  _popupHandler: null,
  _toolbarHandler: null,

  init() {
    this._popupHandler = (e) => this._onSelectionPopup(e);
    this._toolbarHandler = (e) => this._onToolbar(e);
    Zotero.Reader.registerEventListener("renderTextSelectionPopup", this._popupHandler, Wordbook.id);
    Zotero.Reader.registerEventListener("renderToolbar", this._toolbarHandler, Wordbook.id);
    for (const reader of Zotero.Reader._readers || []) this.attach(reader); // already open ones
  },

  shutdown() {
    for (const reader of [...this._states.keys()]) this.detach(reader);
    try {
      Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this._popupHandler);
      Zotero.Reader.unregisterEventListener("renderToolbar", this._toolbarHandler);
    } catch (e) {}
    this._popup = null;
  },

  // ---------- button in the reader toolbar ----------
  _onToolbar({ reader, doc, append }) {
    this.attach(reader);
    const btn = doc.createElement("button");
    btn.className = "toolbar-button";
    btn.textContent = "📖";
    btn.title = "Wordbook — открыть словарь";
    btn.addEventListener("click", () => Wordbook.UI.openDictionary());

    // choice of the book language and the translation language
    const wrap = doc.createElement("span");
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:3px;margin-inline:4px;font-size:12px;";
    const selects = {};
    const refresh = () => {
      const cur = Wordbook.langs();
      for (const w of ["src", "dst"]) selects[w].value = cur[w];
    };
    for (const which of ["src", "dst"]) {
      const sel = doc.createElement("select");
      sel.title = which === "src" ? "Язык книги" : "Перевод на";
      sel.style.cssText = "font-size:12px;padding:1px 2px;background:transparent;color:inherit;border:1px solid rgba(128,128,128,.45);border-radius:4px;";
      for (const [code, L] of Object.entries(Wordbook.LANGS)) {
        const o = doc.createElement("option");
        o.value = code;
        o.textContent = L.short;
        o.title = L.name;
        sel.append(o);
      }
      sel.addEventListener("change", () => {
        Wordbook.setLang(which, sel.value);
        this._popup = null; // the translation in the open popover was computed for the previous language pair
        refresh();
      });
      selects[which] = sel;
    }
    const arrow = doc.createElement("span");
    arrow.textContent = "→";
    wrap.append(selects.src, arrow, selects.dst);
    refresh();
    append(wrap);
    append(btn);
  },

  // ---------- selection popover ----------
  _onSelectionPopup({ reader, doc, params, append }) {
    const annotation = params?.annotation;
    const text = annotation?.text;
    if (!/\p{L}/u.test(String(text ?? ""))) return;
    const wordMode = Wordbook.isCandidate(text);
    // A word or short expression gets a dictionary entry; anything longer gets a translation of the whole sentence/paragraph
    const mode = wordMode ? "word" : String(text).length > Wordbook.MAX_PASSAGE ? "toolong" : "passage";

    const key = Wordbook.normalize(text);
    let st = this._popup;
    if (!st || st.key !== key) {
      st = this._popup = {
        key,
        mode,
        text: mode === "word" ? String(text).replace(/\s+/g, " ").trim() : Wordbook.cleanPassage(text),
        added: false,
        analyzed: false,
      };
    }
    st.reader = reader;
    st.annotation = annotation;
    if (!st.analyzed) {
      st.analyzed = true;
      try {
        if (st.mode === "word") this._analyze(st); // offline — instant, then (if enabled) refined online
        else if (st.mode === "passage") this._analyzePassage(st);
      } catch (e) {
        // an error in our code must not break Zotero's popover
        Wordbook.log("analyze: " + e + "\n" + (e.stack || ""));
        st.onl = st.onl || "off";
        st.pStatus = st.pStatus || "error";
      }
    }

    const box = doc.createElement("div");
    box.style.cssText =
      "display:flex;flex-direction:column;gap:6px;width:100%;min-width:0;max-width:100%;box-sizing:border-box;" +
      "padding:2px 0;font-size:13px;line-height:1.35;overflow-wrap:anywhere;";
    st.view = { doc, box };
    try {
      this._renderPopup(st);
    } catch (e) {
      Wordbook.log("renderPopup: " + e + "\n" + (e.stack || ""));
      box.textContent = "Wordbook: не удалось показать перевод";
    }
    append(box); // append must be called synchronously
  },

  // ---------- sentence / paragraph translation ----------
  _analyzePassage(st) {
    if (!Wordbook.Translator.onlineEnabled) {
      st.pStatus = "off";
      return;
    }
    st.pStatus = "loading";
    const view = st.reader?._internalReader?._primaryView;
    const ctx = Wordbook.PdfText.surroundFor(view, st.annotation);
    Wordbook.Translator.translatePassage(st.text, ctx)
      .then((r) => {
        st.pStatus = "ready";
        st.pResult = r;
      })
      .catch((e) => {
        st.pStatus = "error";
        st.pError = e;
        Wordbook.log("translate passage: " + e.message);
      })
      .then(() => {
        if (this._popup === st) this._renderPopup(st);
      });
  },

  _renderPassage(st) {
    const { doc, box } = st.view;
    const el = (tag, css, text) => {
      const e = doc.createElement(tag);
      if (css) e.style.cssText = css;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const small = (text, extra = "") => el("div", "font-size:11.5px;opacity:.65;" + extra, text);
    const button = (label, onClick) => {
      const b = doc.createElement("button");
      b.className = "toolbar-button wide-button";
      b.style.cssText = "box-sizing:border-box;width:100%;max-width:100%;white-space:normal;";
      b.textContent = label;
      b.addEventListener("click", onClick);
      return b;
    };
    const kids = [];
    if (st.mode === "toolong") {
      kids.push(el("div", "", `Выделение слишком длинное (больше ${Wordbook.MAX_PASSAGE} знаков). Выделите фрагмент поменьше.`));
      box.replaceChildren(...kids);
      return;
    }
    const settings = (label) => button(label, () => Wordbook.UI.openPreferences());

    if (st.pStatus === "loading") {
      kids.push(el("div", "opacity:.7;", "Перевожу…"));
    } else if (st.pStatus === "ready" && st.pResult) {
      kids.push(
        el(
          "div",
          "font-size:14px;line-height:1.45;white-space:pre-wrap;-moz-user-select:text;user-select:text;max-height:320px;overflow:auto;padding-right:4px;",
          st.pResult.text
        )
      );
      kids.push(small(st.pResult.fallbackReason ? `${st.pResult.provider} (запасной вариант)` : st.pResult.provider));
    } else if (st.pStatus === "error") {
      kids.push(el("div", "", st.pError?.message || "Не удалось перевести"));
      kids.push(
        button("Повторить", () => {
          this._analyzePassage(st);
          this._renderPopup(st);
        })
      );
    } else {
      kids.push(el("div", "opacity:.85;", "Перевод предложений работает только онлайн, а он выключен в настройках."));
      kids.push(settings("Открыть настройки"));
    }
    box.replaceChildren(...kids);
  },

  // Words that look like inflected forms but are not («news», «its», «series»…)
  _NOT_FORMS: new Set("news series species means physics mathematics economics politics athletics morning evening during king ring wing thing something anything nothing everything always perhaps sometimes besides towards thus plus bus gas lens yes its his this us was".split(" ")),

  // Base form of a single-word selection and its translation (offline): { word, translation } or null
  _baseForm(text) {
    const w = Wordbook.normalize(text);
    const D = Wordbook.Dict;
    if (!w || !/^[a-z][a-z'’-]*$/.test(w) || !D?.ready || this._NOT_FORMS.has(w) && !Wordbook.Lemma.irregular(w)) return null;
    const has = (c) => D.basic.has(c) || (D.entries.size > 0 && D.entries.has(c));
    let base = Wordbook.Lemma.irregular(w)?.bases.find(has) || null;
    // «number» -> «numb», «early» -> «ear»: for -er/-est/-ly, a word that is itself in the dictionary is not treated as a form
    const derivational = /(er|est|ly)$/.test(w) && has(w);
    if (!base && !derivational) {
      base = Wordbook.Lemma.candidates(w).slice(1).find((c) => c.length >= 3 && has(c)) || null;
    }
    if (!base || base === w) return null;
    try {
      const off = Wordbook.Translator.offline(base);
      return off.text ? { word: base, translation: off.text } : null;
    } catch (e) {
      return null;
    }
  },

  _analyze(st) {
    if (Wordbook.Translator.offlineSupported) st.base = this._baseForm(st.text); // base-form rules — for English
    else {
      // Russian: base form from the dictionary word list, translation — online
      const ru = Wordbook.langs().src === "ru" && /^[\p{L}ё]+$/u.test(st.text.trim()) ? Wordbook.Lemma.ruBase(st.text.trim()) : null;
      st.base = ru ? { word: ru, translation: "" } : null;
    }
    const view = st.reader._internalReader?._primaryView;
    st.context = Wordbook.PdfText.contextFor(view, st.annotation);
    st.idioms = Wordbook.Translator.offlineSupported ? Wordbook.Idioms.analyze(st.text, st.context) : {}; // the idiom database is English

    try {
      st.off = Wordbook.Translator.offline(st.text);
      st.offError = null;
    } catch (e) {
      st.off = null;
      st.offError = e;
    }

    if (!Wordbook.Translator.onlineEnabled) {
      st.onl = "off";
      return;
    }
    st.onl = "loading";
    if (st.base) {
      Wordbook.Translator.online(st.base.word, "")
        .then((r) => {
          if (r?.text) st.base.translation = r.text;
        })
        .catch(() => {})
        .then(() => {
          if (this._popup === st) this._renderPopup(st);
        });
    }
    Wordbook.Translator.online(st.text, st.context)
      .then((r) => {
        st.onl = "ready";
        st.on = r;
        // the model reported a base form — suggest it if we don't have one of our own yet
        const lm = String(r?.lemma || "").trim();
        if (!st.base && lm && Wordbook.normalize(lm) !== Wordbook.normalize(st.text) && /^[\p{L}ё' -]+$/u.test(lm) && !/\s/.test(st.text.trim())) {
          st.base = { word: lm, translation: "" };
          return Wordbook.Translator.online(lm, "").then((b) => { if (b?.text) st.base.translation = b.text; }, () => {});
        }
      })
      .catch((e) => {
        st.onl = "error";
        st.onError = e;
        Wordbook.log("online translate: " + e.message);
      })
      .then(() => {
        if (this._popup === st) this._renderPopup(st);
      });
  },

  // Final data to display: the online translation takes priority over the offline one, except when
  // the selection is a known idiom with a ready Russian equivalent and the online result is an ordinary
  // (non-contextual) machine translation: then the hand-written equivalent is more accurate.
  _best(st) {
    const on = st.onl === "ready" ? st.on : null;
    const off = st.off;
    const keepOff = !!(on && !on.contextual && off?.source === "idioms");
    if (keepOff) {
      const alts = [on.text, ...on.alternatives].filter((t) => t && t.toLowerCase() !== off.text.toLowerCase());
      return {
        translation: off.text,
        alternatives: [...off.alternatives, ...alts].slice(0, 5),
        explanation: "",
        article: off.definition || "",
        sourceTag: "база устойчивых выражений",
        note: "",
      };
    }
    return {
      translation: on?.text || off?.text || "",
      alternatives: on ? on.alternatives : off?.alternatives || [],
      explanation: on?.explanation || "",
      article: off?.definition || "",
      note: on?.fallbackReason ? `Выбранный сервис не ответил, показан запасной перевод. ${on.fallbackReason}` : "",
      sourceTag: on ? (on.fallbackReason ? `${on.provider} (запасной вариант)` : on.provider) : off ? "офлайн-словарь" : "",
    };
  },

  // Expressions for the label: those found offline + those confirmed/found by the model
  _expressions(st) {
    const list = [];
    const seen = new Set();
    const push = (e) => {
      if (e.key && !seen.has(e.key)) {
        seen.add(e.key);
        list.push(e);
      }
    };
    const I = st.idioms || {};
    if (I.exact) push({ key: I.exact.key, type: I.exact.type, ru: I.exact.ru, gloss: I.exact.gloss, where: "exact" });
    for (const m of I.inside || []) push({ key: m.key, type: m.type, ru: m.ru, gloss: m.gloss, where: "inside" });
    for (const m of I.context || []) push({ key: m.key, type: m.type, ru: m.ru, gloss: m.gloss, where: "context" });
    const on = st.onl === "ready" ? st.on : null;
    if (on?.isIdiom && on.expression) {
      const typeRu = { idiom: "идиома", phrasal_verb: "фразовый глагол", proverb: "пословица", collocation: "устойчивое сочетание" }[on.expressionType] || "устойчивое выражение";
      push({ key: Wordbook.normalize(on.expression), type: typeRu, ru: "", gloss: "", where: "online", display: on.expression });
    }
    return list;
  },

  _add(st, { text = st.text, translation, expression = null, isBase = false } = {}) {
    const reader = st.reader;
    const item = Zotero.Items.get(reader.itemID);
    const top = item?.parentItem || item;
    const best = this._best(st);
    const exprInfo = isBase ? null : expression || this._expressions(st).find((e) => e.where === "exact" || e.where === "online" && Wordbook.normalize(e.key) === Wordbook.normalize(st.text));
    Wordbook.Store.add({
      text,
      translation: translation ?? best.translation,
      definition: isBase ? "" : [best.explanation, best.article].filter(Boolean).join("\n\n"),
      context: st.context || "",
      idiom: exprInfo ? { type: exprInfo.type, expression: exprInfo.display || exprInfo.key } : null,
      source: {
        libraryID: item?.libraryID,
        attachmentKey: item?.key,
        itemKey: top?.key,
        title: top?.getField?.("title") || "",
        page: st.annotation?.pageLabel || "",
        pageIndex: st.annotation?.position?.pageIndex,
      },
    });
    st.added = true;
    this._renderPopup(st);
  },

  // Rebuilds the popover contents from the state st
  _renderPopup(st) {
    if (st.mode !== "word") {
      try {
        this._renderPassage(st);
      } catch (e) {
        Wordbook.log("renderPassage: " + e);
      }
      return;
    }
    try {
      const { doc, box } = st.view;
      const existing = Wordbook.Store.lookup(st.text);
      const best = this._best(st);
      const el = (tag, css, text) => {
        const e = doc.createElement(tag);
        if (css) e.style.cssText = css;
        if (text !== undefined) e.textContent = text;
        return e;
      };
      const button = (label, onClick, { wide = true } = {}) => {
        const b = doc.createElement("button");
        if (wide) b.className = "toolbar-button wide-button"; // native look of the popover buttons
        b.style.cssText = "box-sizing:border-box;max-width:100%;white-space:normal;" + (wide ? "width:100%;" : "");
        b.textContent = label;
        b.addEventListener("click", onClick);
        return b;
      };
      const small = (text, extra = "") => el("div", "font-size:11.5px;opacity:.65;" + extra, text);
      const kids = [];

      // 1. Translation
      if (existing) {
        kids.push(el("div", "font-size:15px;font-weight:600;", existing.translation || "(перевод не указан)"));
        if (existing.idiom) kids.push(small("🔖 " + existing.idiom.type, "opacity:.85;"));
      } else if (best.translation) {
        kids.push(el("div", "font-size:15px;font-weight:600;", best.translation));
        const headword = st.off?.headword;
        if (st.onl !== "ready" && st.off?.form === "lemma" && headword && headword !== st.key) {
          kids.push(small(`форма слова «${headword}»`));
        }
        kids.push(small(best.sourceTag));
      } else if (st.onl === "loading") {
        kids.push(el("div", "opacity:.7;", "Перевожу…"));
      } else if (st.offError?.code === "NO_OFFLINE" && st.onl === "error") {
        kids.push(el("div", "opacity:.85;", "Не удалось перевести онлайн."));
      } else if (st.offError?.code === "NO_OFFLINE") {
        kids.push(el("div", "opacity:.85;", "Для этой пары языков нужен онлайн-перевод."));
      } else if (st.offError?.code === "NOT_FOUND") {
        kids.push(el("div", "opacity:.85;", "Точного перевода нет в офлайн-словаре."));
      } else {
        kids.push(el("div", "opacity:.85;", "Перевод не найден."));
      }

      // online translation status
      if (!existing) {
        if (st.onl === "loading" && best.translation) kids.push(small("⏳ уточняю онлайн…"));
        if (st.onl === "error") {
          const code = st.onError?.code;
          const msg =
            code === "NETWORK" ? "нет интернета — показан офлайн-перевод" : `онлайн-перевод недоступен: ${st.onError?.message || "ошибка"}`;
          kids.push(small("⚠ " + msg, "color:#c0561b;opacity:.95;"));
        }
      }

      // 2. Idiom / fixed-expression label
      const exprs = this._expressions(st);
      for (const ex of exprs) {
        const box2 = el(
          "div",
          "padding:6px 8px;border-radius:6px;background:rgba(255,200,0,.18);border-left:3px solid #e0a800;display:flex;flex-direction:column;gap:2px;"
        );
        const title =
          ex.where === "context"
            ? `🔖 Возможно, часть выражения «${ex.display || ex.key}»`
            : ex.where === "inside"
              ? `🔖 В выделении есть выражение «${ex.display || ex.key}»`
              : ex.where === "online" && ex.key !== st.key
                ? `🔖 Часть выражения «${ex.display || ex.key}»`
                : `🔖 ${ex.type[0].toUpperCase() + ex.type.slice(1)}`;
        box2.append(el("div", "font-weight:600;", title));
        if (ex.where !== "exact" && !(ex.where === "online" && ex.key === st.key)) box2.append(small(ex.type));
        if (ex.ru && ex.where !== "exact") box2.append(el("div", "", ex.ru));
        if (ex.gloss && !ex.ru) box2.append(small(ex.gloss));
        if (!existing && ex.where !== "exact" && ex.key !== Wordbook.normalize(st.text)) {
          const exKey = ex.key;
          box2.append(
            button(`＋ В словарь: «${ex.display || exKey}»`, () => {
              this._add(st, { text: ex.display || exKey, translation: ex.ru || "", expression: ex });
            }, { wide: false })
          );
        }
        kids.push(box2);
      }

      // 3. Model's explanation
      if (!existing && st.onl === "ready" && st.on.explanation) {
        kids.push(el("div", "font-size:12.5px;", st.on.explanation));
      }

      // 4. Hint on the words if the phrase is not in the dictionary
      if (!existing && !best.translation && st.offError?.hints?.length) {
        kids.push(small("Подсказка по отдельным словам:"));
        for (const h of st.offError.hints) kids.push(el("div", "font-size:12.5px;", `${h.word} — ${h.gloss}`));
      }

      // 5. Actions
      if (existing) {
        const isForm = (existing.word || existing.key) !== Wordbook.normalize(st.text);
        kids.push(small(st.added ? "✓ Добавлено в словарь" : isForm ? `✓ В словаре как «${existing.word || existing.key}»` : "✓ Уже в словаре", "opacity:.8;"));
        const row = el("div", "display:flex;gap:6px;");
        row.append(
          button("Изменить…", () => Wordbook.UI.openDictionary(existing.key)),
          button("Удалить", () => {
            Wordbook.Store.remove(existing.key);
            st.added = false;
            this._renderPopup(st);
          })
        );
        kids.push(row);
      } else {
        const label = best.translation ? "＋ В словарь" : "＋ В словарь без перевода";
        kids.push(button(label, () => this._add(st)));
        if (st.base) {
          const have = Wordbook.Store.lookup(st.base.word);
          const box2 = el("div", "display:flex;flex-direction:column;gap:3px;padding:5px 7px;border:1px solid rgba(128,128,128,.4);border-radius:6px;");
          box2.append(small("Начальная форма:", "margin:0;"));
          box2.append(el("div", "font-size:14px;font-weight:600;", st.base.translation ? `${st.base.word} — ${st.base.translation}` : st.base.word));
          if (have) {
            box2.append(small("✓ уже в словаре"));
          } else {
            box2.append(button(`＋ В словарь: «${st.base.word}»`, () => this._add(st, { text: st.base.word, translation: st.base.translation, isBase: true })));
          }
          kids.push(box2);
        }
        if (best.alternatives?.length) {
          kids.push(small("Другие значения — нажмите, чтобы добавить с ним:", "margin-top:2px;"));
          const chips = el("div", "display:flex;flex-wrap:wrap;gap:4px;");
          for (const alt of best.alternatives) {
            const chip = button(alt, () => this._add(st, { translation: alt }), { wide: false });
            chip.style.cssText =
              "padding:2px 9px;border:1px solid rgba(128,128,128,.5);border-radius:12px;" +
              "background:transparent;color:inherit;font:inherit;cursor:pointer;";
            chips.append(chip);
          }
          kids.push(chips);
        }
      }

      // 6. Dictionary entry
      if (!existing && best.article) {
        const det = doc.createElement("details");
        det.style.cssText = "font-size:12px;";
        det.append(el("summary", "cursor:pointer;opacity:.75;", "Вся статья словаря"));
        det.append(el("div", "white-space:pre-wrap;max-height:200px;overflow:auto;margin-top:4px;", best.article));
        kids.push(det);
      }
      box.replaceChildren(...kids);
    } catch (e) {
      Wordbook.log("renderPopup: " + e);
    }
  },

  // ---------- attaching highlighting to the PDF ----------
  attach(reader) {
    if (!reader || reader.type !== "pdf" || this._states.has(reader)) return;
    const state = { alive: true, view: null };
    this._states.set(reader, state);
    this._loop(reader, state);
  },

  detach(reader) {
    const state = this._states.get(reader);
    if (!state) return;
    state.alive = false;
    if (state.view) Wordbook.Highlighter.detach(state.view);
    this._states.delete(reader);
  },

  // Every half second: attach the view when it appears (or is recreated), and update
  // the layer if pdf.js has re-rendered the pages
  async _loop(reader, state) {
    try {
      await reader._initPromise;
    } catch (e) {}
    while (state.alive) {
      try {
        const view = reader._internalReader?._primaryView;
        if (view && view !== state.view) {
          if (state.view) Wordbook.Highlighter.detach(state.view);
          state.view = Wordbook.Highlighter.attach(view) ? view : null;
        }
        if (state.view) Wordbook.Highlighter.sync(state.view);
      } catch (e) {
        Wordbook.log("sync error: " + e);
      }
      await Zotero.Promise.delay(500);
      if (!this._isOpen(reader)) this.detach(reader);
    }
  },

  _isOpen(reader) {
    const list = Zotero.Reader._readers;
    return Array.isArray(list) ? list.includes(reader) : true;
  },
};
