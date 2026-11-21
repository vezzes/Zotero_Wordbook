// Preferences pane script. Here Zotero.Wordbook is the plugin object (see Wordbook.init).
(function () {
  function wire() {
    const btn = document.getElementById("wordbook-test-btn");
    const out = document.getElementById("wordbook-test-result");
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("command", async () => {
      out.setAttribute("value", "Проверяю…");
      try {
        const r = await Zotero.Wordbook.Translator.test();
        out.setAttribute("value", (r.ok ? "✓ " : "✗ ") + r.message);
      } catch (e) {
        out.setAttribute("value", "✗ " + e.message);
      }
    });
  }
  // the pane may be rendered later than the script
  wire();
  window.addEventListener("load", wire);
  setTimeout(wire, 300);
})();
