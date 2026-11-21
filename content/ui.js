/* global Zotero, ChromeUtils, Wordbook */
// Interface in the main Zotero window: items in the "Tools" menu + the dictionary window.

Wordbook.UI = {
  _ids: ["wordbook-sep", "wordbook-open", "wordbook-import-dict", "wordbook-export-anki", "wordbook-prefs"],
  _dictWindow: null,

  addToWindow(win) {
    const doc = win.document;
    if (doc.getElementById(this._ids[1])) return;
    const popup = doc.getElementById("menu_ToolsPopup");
    if (!popup) return;

    const sep = doc.createXULElement("menuseparator");
    sep.id = this._ids[0];
    popup.append(
      sep,
      this._item(doc, this._ids[1], "Wordbook: словарь…", () => this.openDictionary()),
      this._item(doc, this._ids[2], "Wordbook: загрузить словарь (StarDict)…", () => this.importDictionary(win)),
      this._item(doc, this._ids[3], "Wordbook: отправить новые слова в Anki", () => this.exportAnki()),
      this._item(doc, this._ids[4], "Wordbook: настройки…", () => this.openPreferences())
    );
  },

  removeFromWindow(win) {
    for (const id of this._ids) win.document.getElementById(id)?.remove();
  },

  _item(doc, id, label, onCommand) {
    const item = doc.createXULElement("menuitem");
    item.id = id;
    item.setAttribute("label", label);
    item.addEventListener("command", onCommand);
    return item;
  },

  // Opens the dictionary window (a single one shared by all); focusKey — select the row of this word
  openDictionary(focusKey = null) {
    try {
      if (this._dictWindow && !this._dictWindow.closed) {
        this._dictWindow.focus();
        return;
      }
      const main = Zotero.getMainWindow();
      this._dictWindow = main.openDialog(
        "chrome://wordbook/content/dictionary.xhtml",
        "wordbook-dictionary",
        "chrome,dialog=no,centerscreen,resizable,width=900,height=600",
        { Wordbook, Zotero, focusKey }
      );
    } catch (e) {
      Wordbook.log("openDictionary: " + e);
      Wordbook.notify("Не удалось открыть окно словаря: " + e.message, true);
    }
  },

  // Opens the Zotero settings on the Wordbook pane
  openPreferences() {
    try {
      Zotero.Utilities.Internal.openPreferences("wordbook-prefpane");
    } catch (e) {
      Wordbook.log("openPreferences: " + e);
      Wordbook.notify("Откройте Настройки Zotero → Wordbook", true);
    }
  },

  closeDictionary() {
    try {
      this._dictWindow?.close();
    } catch (e) {}
    this._dictWindow = null;
  },

  // Choose a StarDict dictionary .ifo file (for example, Mueller 7) and import it
  async importDictionary(win = Zotero.getMainWindow()) {
    try {
      const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
      const fp = new FilePicker();
      fp.init(win, "Выберите файл словаря StarDict (.ifo)", fp.modeOpen);
      fp.appendFilter("StarDict (*.ifo)", "*.ifo");
      const rv = await fp.show();
      if (rv !== fp.returnOK) return;

      const pw = new Zotero.ProgressWindow({ closeOnClick: false });
      pw.changeHeadline("Wordbook: загрузка словаря");
      const line = new pw.ItemProgress("", "Начинаю…");
      pw.show();
      try {
        const r = await Wordbook.Dict.importStarDict(fp.file, win, (msg) => line.setText(msg));
        line.setProgress(100);
        line.setText(`«${r.name}»: статей — ${r.count}`);
        pw.startCloseTimer(5000);
        Wordbook.emit("words-updated");
      } catch (e) {
        pw.close();
        throw e;
      }
    } catch (e) {
      Wordbook.log("importDictionary: " + e);
      Wordbook.notify("Не удалось загрузить словарь: " + e.message, true);
    }
  },

  async exportAnki() {
    try {
      const r = await Wordbook.Anki.exportPending();
      if (!r.total && !r.updated) return Wordbook.notify("Нет новых слов для экспорта");
      Wordbook.notify(
        `Добавлено в Anki: ${r.added}. Уже были в Anki: ${r.duplicates}.` +
          (r.updated ? ` Дополнен контекст у ранее выгруженных: ${r.updated}.` : "") +
          (r.noContext ? ` Без контекста: ${r.noContext} (при добавлении слова предложение не сохранилось).` : "") +
          (r.failed ? ` Не удалось: ${r.failed}.` : "")
      );
    } catch (e) {
      Wordbook.log("export error: " + e);
      Wordbook.notify(e.message, true);
    }
  },
};
