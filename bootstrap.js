/* global Zotero, Services, Components */
// Plugin entry point. Only the lifecycle lives here; all the logic is in content/*.js

var Wordbook;
var chromeHandle;

function log(msg) {
  Zotero.debug("[Wordbook] " + msg);
}

function install() {}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise; // Zotero windows and reader are ready
  log("startup " + version);

  // chrome://wordbook/content/… — needed for the dictionary window
  const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"].getService(
    Components.interfaces.amIAddonManagerStartup
  );
  chromeHandle = aomStartup.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
    ["content", "wordbook", rootURI + "content/"],
  ]);

  // Order matters: the core first (it creates the global Wordbook object), then the modules
  for (const file of [
    "wordbook.js",
    "lib/snowball.js",
    "morph.js",
    "store.js",
    "lemma.js",
    "dict.js",
    "idioms.js",
    "packs.js",
    "translator.js",
    "pdf-text.js",
    "highlighter.js",
    "reader.js",
    "anki.js",
    "ui.js",
  ]) {
    Services.scriptloader.loadSubScript(rootURI + "content/" + file);
  }

  Zotero.PreferencePanes.register({
    pluginID: id,
    id: "wordbook-prefpane",
    src: rootURI + "content/preferences.xhtml",
    scripts: [rootURI + "content/preferences.js"],
    label: "Wordbook",
  });

  await Wordbook.init({ id, version, rootURI });

  // Windows opened before the plugin started
  for (const win of Zotero.getMainWindows()) {
    Wordbook.UI.addToWindow(win);
  }
}

function onMainWindowLoad({ window }) {
  Wordbook?.UI.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  Wordbook?.UI.removeFromWindow(window);
}

function shutdown() {
  log("shutdown");
  if (Wordbook) {
    for (const win of Zotero.getMainWindows()) {
      Wordbook.UI.removeFromWindow(win);
    }
    Wordbook.UI.closeDictionary();
    Wordbook.shutdown();
    Wordbook = undefined;
  }
  chromeHandle?.destruct();
  chromeHandle = null;
}

function uninstall() {}
