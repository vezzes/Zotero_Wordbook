/* global Wordbook */
// PDF page text built from the characters Zotero stores for each page.
// Character: { c, rect, inlineRect, ignorable, spaceAfter, lineBreakAfter, wordBreakAfter, paragraphBreakAfter }
// Coordinates are in PDF space (origin at bottom left, Y axis pointing up).
//
// Module tasks:
//  1) build a string from the characters for searching words with a regular expression (build);
//  2) for a found fragment, get rectangles — one per line (rectsForRange);
//  3) for the user's selection, find the context sentence for the Anki card (contextFor).

Wordbook.PdfText = {
  // Returns { text, textToChar, charToText }:
  //   textToChar[i] — page character index for the i-th character of the string,
  //   charToText[j] — position of the j-th character in the string (or -1 if it did not make it into the string).
  build(chars) {
    const out = [];
    const textToChar = [];
    const charToText = new Array(chars.length).fill(-1);

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch.ignorable || !ch.c) continue;

      // Word hyphenated at the end of a line: "exam-" + "ple" -> "example"
      const next = chars[i + 1];
      if (
        ch.lineBreakAfter &&
        /^[-­‐‑]$/.test(ch.c) &&
        next &&
        /^\p{Ll}/u.test(next.c || "")
      ) {
        continue;
      }

      const c = String(ch.c).normalize("NFKC"); // ligatures ﬁ -> fi
      charToText[i] = out.length;
      for (let k = 0; k < c.length; k++) {
        out.push(c[k]);
        textToChar.push(i);
      }
      if (ch.spaceAfter || ch.lineBreakAfter || ch.paragraphBreakAfter) {
        out.push(" ");
        textToChar.push(i);
      }
    }
    return { text: out.join(""), textToChar, charToText };
  },

  // Rectangles of the fragment text[start, end): one per line, in PDF coordinates
  rectsForRange(chars, built, start, end) {
    const first = built.textToChar[start];
    const last = built.textToChar[end - 1];
    if (first === undefined || last === undefined) return [];

    const lines = [];
    let cur = null;
    for (let i = first; i <= last; i++) {
      const ch = chars[i];
      if (ch.ignorable) continue;
      const r = ch.inlineRect || ch.rect;
      if (!r) continue;
      const rr = [
        Math.min(r[0], r[2]),
        Math.min(r[1], r[3]),
        Math.max(r[0], r[2]),
        Math.max(r[1], r[3]),
      ];
      cur = cur
        ? [
            Math.min(cur[0], rr[0]),
            Math.min(cur[1], rr[1]),
            Math.max(cur[2], rr[2]),
            Math.max(cur[3], rr[3]),
          ]
        : rr;
      if (ch.lineBreakAfter && i !== last) {
        lines.push(cur);
        cur = null;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  },

  // String range [start, end) for the characters whose centres lie within the selection rectangles
  rangeForRects(chars, built, rects) {
    const boxes = rects.map((q) => [
      Math.min(q[0], q[2]),
      Math.min(q[1], q[3]),
      Math.max(q[0], q[2]),
      Math.max(q[1], q[3]),
    ]);
    let min = Infinity;
    let max = -1;
    for (let i = 0; i < chars.length; i++) {
      const t = built.charToText[i];
      if (t < 0) continue;
      const r = chars[i].rect;
      if (!r) continue;
      const cx = (r[0] + r[2]) / 2;
      const cy = (r[1] + r[3]) / 2;
      if (boxes.some((b) => cx >= b[0] && cx <= b[2] && cy >= b[1] && cy <= b[3])) {
        min = Math.min(min, t);
        max = Math.max(max, t);
      }
    }
    return max < 0 ? null : [min, max + 1];
  },

  // The sentence containing the fragment text[start, end)
  sentenceAround(text, start, end, maxLen = 280) {
    const WINDOW = 400;
    const base = Math.max(0, start - WINDOW);
    let s = base === 0 ? 0 : start; // if the sentence is longer than the window, start at the selection
    const before = text.slice(base, start);
    let found = false;
    for (const m of before.matchAll(/(?:[.!?…]["'”’)\]]*\s+|[。！？]+[”’」』）)]*)/g)) {
      s = base + m.index + m[0].length;
      found = true;
    }
    if (!found && base > 0) s = base;

    let e;
    const after = text.slice(end, end + WINDOW);
    const m2 = /(?:[.!?…]["'”’)\]]*(?=\s|$)|[。！？]+[”’」』）)]*)/.exec(after);
    e = m2 ? end + m2.index + m2[0].length : Math.min(text.length, end + WINDOW);

    let sentence = text.slice(s, e).replace(/\s+/g, " ").trim();
    if (sentence.length > maxLen) {
      const rel = Math.max(0, start - s);
      const from = Math.max(0, rel - 120);
      sentence = (from > 0 ? "…" : "") + sentence.slice(from, from + maxLen).trim() + "…";
    }
    return sentence;
  },

  // Context sentence for the selection (params.annotation from the reader popup)
  contextFor(view, annotation) {
    let ctx = "";
    try {
      const pos = annotation?.position;
      const chars = view?._pdfPages?.[pos?.pageIndex]?.chars;
      if (chars?.length && pos?.rects?.length) {
        const built = this.build(chars);
        const range = this.rangeForRects(chars, built, pos.rects);
        if (range) ctx = this.sentenceAround(built.text, range[0], range[1]);
      }
    } catch (e) {
      Wordbook.log("contextFor: " + e);
    }
    if (!ctx) ctx = this._contextFromSelection(view, annotation?.text);
    if (!ctx) Wordbook.log("contextFor: предложение не найдено (страница " + annotation?.position?.pageIndex + ")");
    return ctx;
  },

  // Text before and after the selection (for translating a fragment with its surroundings): { before, after }.
  // Taken from the same page; trimmed at sentence boundaries.
  surroundFor(view, annotation, nBefore = 600, nAfter = 300) {
    try {
      const pos = annotation?.position;
      const chars = view?._pdfPages?.[pos?.pageIndex]?.chars;
      if (!chars?.length || !pos?.rects?.length) return { before: "", after: "" };
      const built = this.build(chars);
      const range = this.rangeForRects(chars, built, pos.rects);
      if (!range) return { before: "", after: "" };
      let before = built.text.slice(Math.max(0, range[0] - nBefore), range[0]);
      let after = built.text.slice(range[1], range[1] + nAfter);
      if (range[0] - nBefore > 0) before = before.replace(/^[^.!?…。！？]*(?:[.!?…]["'”’)\]]*\s+|[。！？]+[”’」』）)]*)/, ""); // start with a whole sentence
      if (built.text.length > range[1] + nAfter) after = after.replace(/\s+[^.!?…。！？]*$/, (m) => (/[.!?…。！？]/.test(m) ? m : "")); // don't cut off mid-word
      return { before: before.replace(/\s+/g, " ").trim(), after: after.replace(/\s+/g, " ").trim() };
    } catch (e) {
      Wordbook.log("surroundFor: " + e);
      return { before: "", after: "" };
    }
  },

  // Fallback: page text from the pdf.js text layer around the current selection
  _contextFromSelection(view, selected) {
    try {
      const win = view?._iframeWindow;
      const sel = win?.getSelection?.();
      const node = sel?.anchorNode;
      const el = node?.nodeType === 1 ? node : node?.parentElement;
      const layer = el?.closest?.(".textLayer") || el?.closest?.(".page");
      if (!layer) return "";
      const text = Array.from(layer.querySelectorAll("span"))
        .map((sp) => sp.textContent)
        .join(" ")
        .replace(/-\s+(?=\p{Ll})/gu, "")
        .replace(/\s+/g, " ");
      const needle = String(selected || sel.toString() || "").replace(/\s+/g, " ").trim();
      if (!needle) return "";
      const i = text.toLowerCase().indexOf(needle.toLowerCase());
      return i < 0 ? "" : this.sentenceAround(text, i, i + needle.length);
    } catch (e) {
      Wordbook.log("contextFromSelection: " + e);
      return "";
    }
  },
};
