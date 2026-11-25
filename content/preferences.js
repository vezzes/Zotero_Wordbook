// Preferences pane script. Here Zotero.Wordbook is the plugin object (see Wordbook.init).
(function () {
  const W = () => Zotero.Wordbook;

  // ---------- «Проверить подключение» ----------
  function wireTest() {
    const btn = document.getElementById("wordbook-test-btn");
    const out = document.getElementById("wordbook-test-result");
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("command", async () => {
      out.setAttribute("value", "Проверяю…");
      try {
        const r = await W().Translator.test();
        out.setAttribute("value", (r.ok ? "✓ " : "✗ ") + r.message);
      } catch (e) {
        out.setAttribute("value", "✗ " + e.message);
      }
    });
  }

  // ---------- «Офлайн-словари» ----------
  const progress = new Map(); // pack id -> text on the button while it is being downloaded
  let errors = new Map(); // pack id -> error text

  const mb = (n) => (n / 1048576).toFixed(n < 1048576 * 10 ? 1 : 0).replace(".", ",") + " МБ";
  const words = (n) => (n >= 1000 ? Math.round(n / 1000) + " тыс. слов" : n + " слов");

  function el(tag, attrs = {}, style = "") {
    const e = document.createXULElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (style) e.setAttribute("style", style);
    return e;
  }

  function setStatus(text) {
    document.getElementById("wordbook-packs-status")?.setAttribute("value", text || "");
  }

  function packRows() {
    const w = W();
    const L = w.LANGS;
    const cur = w.langs();
    const byId = new Map();
    for (const m of w.Packs.catalog?.packs || []) byId.set(m.id, { meta: m, have: w.Packs._index[m.id] || null });
    for (const h of w.Packs.installed()) if (!byId.has(h.id)) byId.set(h.id, { meta: null, have: h });
    const rows = [...byId.values()];
    const rank = (r) => {
      const x = r.meta || r.have;
      if (x.src === cur.src && x.dst === cur.dst) return 0; // the current pair
      if (x.src === cur.src || x.dst === cur.dst || x.src === cur.dst || x.dst === cur.src) return 1;
      return 2;
    };
    const order = Object.keys(L);
    rows.sort((a, b) => {
      const x = a.meta || a.have;
      const y = b.meta || b.have;
      return rank(a) - rank(b) || order.indexOf(x.src) - order.indexOf(y.src) || order.indexOf(x.dst) - order.indexOf(y.dst);
    });
    return rows;
  }

  function render() {
    const list = document.getElementById("wordbook-packs-list");
    if (!list || !W()) return;
    const w = W();
    const L = w.LANGS;
    const cur = w.langs();
    list.textContent = "";
    const rows = packRows();
    if (!rows.length) {
      list.append(el("label", { value: "Список пока пуст. Нажмите «Обновить список» (нужен интернет)." }, "margin:6px 0;"));
      return;
    }
    for (const { meta, have } of rows) {
      const x = meta || have;
      const isCur = x.src === cur.src && x.dst === cur.dst;
      const row = el("hbox", { align: "center" }, "margin:3px 0;padding:3px 6px;border-radius:5px;" + (isCur ? "background:rgba(120,120,120,.15);" : ""));
      const name = `${L[x.src]?.name || x.src} → ${L[x.dst]?.name || x.dst}`;
      const title = el("label", { value: name + (isCur ? "  (текущая пара)" : ""), flex: "1" }, isCur ? "font-weight:bold;" : "");
      const size = el("label", { value: meta ? `${mb(meta.size)} · ${words(meta.entries)}` : `${mb(have.size)} · ${words(have.entries)}` }, "opacity:.75;min-width:150px;text-align:right;");
      row.append(title, size);

      const busy = progress.has(x.id);
      const state = meta ? w.Packs.stateOf(meta) : "ok";
      if (busy) {
        const b = el("button", { label: progress.get(x.id), disabled: "true" }, "min-width:130px;");
        row.append(b);
      } else if (state === "new") {
        const b = el("button", { label: "Скачать" }, "min-width:130px;");
        b.addEventListener("command", () => install(meta));
        row.append(b);
      } else {
        if (state === "update") {
          const b = el("button", { label: "Обновить" }, "min-width:90px;");
          b.addEventListener("command", () => install(meta));
          row.append(b);
        } else {
          row.append(el("label", { value: "✓ установлен" }, "color:#2e7d32;min-width:90px;text-align:right;"));
        }
        const d = el("button", { label: "Удалить" });
        d.addEventListener("command", () => remove(x, name));
        row.append(d);
      }
      list.append(row);
      const err = errors.get(x.id);
      if (err) list.append(el("label", { value: "⚠ " + err }, "color:#c0561b;margin:0 6px 4px;"));
      if (meta && !busy) {
        const info = [meta.note, `источник: ${meta.source || "—"}`, `лицензия: ${meta.license || "—"}`].filter(Boolean).join(" · ");
        const d = el("description", {}, "font-size:11px;opacity:.65;margin:0 6px 4px;max-width:640px;");
        d.textContent = info;
        list.append(d);
      }
    }
  }

  async function refresh() {
    setStatus("Загружаю список…");
    try {
      await W().Packs.fetchCatalog();
      setStatus("");
    } catch (e) {
      setStatus("⚠ " + e.message);
    }
    render();
  }

  async function install(meta) {
    errors.delete(meta.id);
    progress.set(meta.id, "Скачиваю…");
    render();
    try {
      await W().Packs.install(meta, (got, total) => {
        const pct = total ? Math.min(99, Math.round((got / total) * 100)) : null;
        progress.set(meta.id, pct === null ? "Скачиваю…" : `Скачиваю ${pct}%`);
        render();
      });
    } catch (e) {
      errors.set(meta.id, e.message);
    }
    progress.delete(meta.id);
    render();
  }

  async function remove(x, name) {
    if (!Services.prompt.confirm(window, "Wordbook", `Удалить офлайн-словарь «${name}»? Его можно скачать снова.`)) return;
    try {
      await W().Packs.remove(x.id);
    } catch (e) {
      errors.set(x.id, e.message);
    }
    render();
  }

  let wired = false;
  function wirePacks() {
    const btn = document.getElementById("wordbook-packs-refresh");
    if (!btn || btn.dataset.wired || !W()) return;
    btn.dataset.wired = "1";
    btn.addEventListener("command", refresh);
    W().on("packs-changed", render);
    window.addEventListener("unload", () => W()?.off?.("packs-changed", render));
    wired = true;
    render();
    if (!W().Packs.catalog) refresh();
  }

  function wire() {
    wireTest();
    wirePacks();
  }
  // the pane may be rendered later than the script
  wire();
  window.addEventListener("load", wire);
  setTimeout(wire, 300);
})();
