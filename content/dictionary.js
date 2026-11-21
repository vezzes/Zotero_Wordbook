// Dictionary window. Wordbook and Zotero are passed via window.arguments[0] (see ui.js).
(function () {
  const { Wordbook, Zotero } = window.arguments[0];
  const $ = (id) => document.getElementById(id);
  let focusKey = window.arguments[0].focusKey || null;

  function matches(w, q) {
    if (!q) return true;
    q = q.toLowerCase();
    return (
      (w.word || w.key).includes(q) ||
      (w.translation || "").toLowerCase().includes(q) ||
      (w.source?.title || "").toLowerCase().includes(q)
    );
  }

  function openInBook(w) {
    try {
      const s = w.source || {};
      const item = Zotero.Items.getByLibraryAndKey(s.libraryID, s.attachmentKey || s.itemKey);
      if (!item) return setStatus("Книга не найдена в библиотеке");
      Zotero.Reader.open(item.id, Number.isInteger(s.pageIndex) ? { pageIndex: s.pageIndex } : undefined);
    } catch (e) {
      setStatus("Не удалось открыть книгу");
    }
  }

  function setStatus(text) {
    $("status").textContent = text;
    if (text) setTimeout(() => ($("status").textContent === text ? ($("status").textContent = "") : 0), 4000);
  }

  function render() {
    const q = $("q").value.trim();
    const all = Wordbook.Store.all().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    const list = all.filter((w) => matches(w, q));
    const rows = $("rows");
    rows.replaceChildren();

    for (const w of list) {
      const tr = document.createElement("tr");

      const tdWord = document.createElement("td");
      tdWord.className = "word";
      tdWord.textContent = w.text;
      {
        const L = Wordbook.LANGS;
        const lg = document.createElement("div");
        lg.className = "ctx";
        lg.textContent = `${L[w.lang]?.short || "EN"} → ${L[w.dst]?.short || "RU"}`;
        tdWord.append(lg);
      }
      if (w.idiom) {
        const tag = document.createElement("div");
        tag.className = "ctx";
        tag.textContent = "🔖 " + w.idiom.type;
        tdWord.append(tag);
      }

      const tdTr = document.createElement("td");
      const input = document.createElement("input");
      input.value = w.translation || "";
      input.placeholder = "введите перевод";
      input.addEventListener("change", () => {
        Wordbook.Store.update(w.key, { translation: input.value.trim() });
        setStatus("Сохранено");
      });
      tdTr.append(input);
      if (w.context) {
        const c = document.createElement("div");
        c.className = "ctx";
        c.textContent = "“" + w.context + "”";
        tdTr.append(c);
      }

      const tdSrc = document.createElement("td");
      tdSrc.className = "src";
      if (w.source?.title) {
        const a = document.createElement("a");
        a.textContent = w.source.title + (w.source.page ? ", с. " + w.source.page : "");
        a.title = "Открыть книгу на этой странице";
        a.addEventListener("click", () => openInBook(w));
        tdSrc.append(a);
      }

      const tdAnki = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "badge" + (w.anki ? " done" : "");
      badge.textContent = w.anki ? (w.anki.duplicate ? "уже было" : "в Anki") : "новое";
      tdAnki.append(badge);

      const tdDel = document.createElement("td");
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "✕";
      del.title = "Удалить из словаря";
      del.addEventListener("click", () => {
        if (window.confirm(`Удалить «${w.text}» из словаря?`)) Wordbook.Store.remove(w.key);
      });
      tdDel.append(del);

      tr.append(tdWord, tdTr, tdSrc, tdAnki, tdDel);
      tr.dataset.key = w.key;
      rows.append(tr);
    }

    $("empty").hidden = all.length > 0;
    const pending = all.filter((w) => !w.anki).length;
    $("count").textContent = `Слов: ${all.length}` + (q ? ` (найдено ${list.length})` : "") + ` · ещё не в Anki: ${pending}`;
    $("exportAnki").disabled = pending === 0;
    $("exportTsv").disabled = pending === 0;

    if (focusKey) {
      const row = rows.querySelector(`tr[data-key="${CSS.escape(focusKey)}"]`);
      if (row) {
        row.scrollIntoView({ block: "center" });
        row.querySelector("input")?.focus();
      }
      focusKey = null;
    }
  }

  $("q").addEventListener("input", render);

  $("exportAnki").addEventListener("click", async () => {
    $("exportAnki").disabled = true;
    setStatus("Отправляю в Anki…");
    try {
      const r = await Wordbook.Anki.exportPending();
      setStatus(
        `Добавлено: ${r.added}, уже были в Anki: ${r.duplicates}` +
          (r.updated ? `, дополнен контекст: ${r.updated}` : "") +
          (r.noContext ? `, без контекста: ${r.noContext}` : "") +
          (r.failed ? `, ошибок: ${r.failed}` : "")
      );
    } catch (e) {
      setStatus(e.message);
      window.alert(e.message);
    }
    render();
  });

  $("exportTsv").addEventListener("click", async () => {
    try {
      const r = await Wordbook.Anki.exportTsv(window);
      if (r) setStatus(`Сохранено слов: ${r.count}`);
    } catch (e) {
      setStatus(e.message);
    }
    render();
  });

  // redraw when words are added from the reader while the window is open
  const onUpdate = () => render();
  Wordbook.on("words-updated", onUpdate);
  window.addEventListener("unload", () => Wordbook.off("words-updated", onUpdate));

  render();
})();
