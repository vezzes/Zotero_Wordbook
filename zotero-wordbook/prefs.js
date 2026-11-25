// Default values. Read via Wordbook.getPref("targetLang") etc.
pref("extensions.zotero.wordbook.sourceLang", "en");
pref("extensions.zotero.wordbook.targetLang", "ru");
pref("extensions.zotero.wordbook.highlightColor", "#ffc800"); // hex or rgba(...)
pref("extensions.zotero.wordbook.highlightOpacity", 40); // % (for hex)
pref("extensions.zotero.wordbook.hoverDelay", 250);
pref("extensions.zotero.wordbook.maxSelectionWords", 8); // longer — we treat it as not a word/expression
pref("extensions.zotero.wordbook.ankiUrl", "http://127.0.0.1:8765");
pref("extensions.zotero.wordbook.ankiDeck", "Zotero Wordbook");
pref("extensions.zotero.wordbook.ankiModel", "Zotero Wordbook");
// Online translation (optional)
pref("extensions.zotero.wordbook.llmProvider", "free"); // free (no cost, no key) | gemini | openai (DeepSeek etc.) | off (offline only)
pref("extensions.zotero.wordbook.llmKey", "");
pref("extensions.zotero.wordbook.llmModel", ""); // empty = the service's default model
pref("extensions.zotero.wordbook.llmBaseUrl", "https://api.deepseek.com");
