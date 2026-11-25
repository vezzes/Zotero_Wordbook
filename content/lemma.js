/* global Wordbook */
// Offline reduction of English word forms to the base form.
// It does not work "blindly": it generates candidates and Dict.lookup() checks each against the dictionary,
// so extra candidates are harmless. Irregular verbs and nouns are handled by a table.

(function () {
  // base form: forms separated by commas
  const IRREGULAR_RAW =
    "be:am,is,are,was,were,been,being;have:has,had,having;do:does,did,done,doing;go:goes,went,gone,going;" +
    "say:said;make:made;get:got,gotten;know:knew,known;think:thought;take:took,taken;see:saw,seen;come:came;" +
    "give:gave,given;find:found;tell:told;become:became;leave:left;feel:felt;put:putting;bring:brought;" +
    "begin:began,begun;keep:kept;hold:held;write:wrote,written;stand:stood;hear:heard;let:letting;mean:meant;" +
    "set:setting;meet:met;run:ran,running;pay:paid;sit:sat;speak:spoke,spoken;lie:lay,lain,lying;lead:led;" +
    "read:reading;grow:grew,grown;lose:lost;fall:fell,fallen;send:sent;build:built;understand:understood;" +
    "draw:drew,drawn;break:broke,broken;spend:spent;cut:cutting;rise:rose,risen;drive:drove,driven;buy:bought;" +
    "wear:wore,worn;choose:chose,chosen;seek:sought;throw:threw,thrown;catch:caught;deal:dealt;win:won,winning;" +
    "forget:forgot,forgotten;lay:laid;hang:hung;shake:shook,shaken;sell:sold;fight:fought;teach:taught;" +
    "eat:ate,eaten;sing:sang,sung;swim:swam,swum;fly:flew,flown;hide:hid,hidden;ride:rode,ridden;" +
    "strike:struck;sleep:slept;bear:bore,borne;beat:beaten;bend:bent;bind:bound;bite:bit,bitten;blow:blew,blown;" +
    "burn:burnt;dig:dug;feed:fed;forgive:forgave,forgiven;freeze:froze,frozen;hit:hitting;hurt:hurting;" +
    "lend:lent;light:lit;ring:rang,rung;shoot:shot;shut:shutting;slide:slid;spin:spun;split:splitting;" +
    "spread:spreading;steal:stole,stolen;stick:stuck;sweep:swept;swing:swung;tear:tore,torn;wake:woke,woken;" +
    "weave:wove,woven;withdraw:withdrew,withdrawn;undergo:underwent,undergone;overcome:overcame;" +
    "mistake:mistook,mistaken;oversee:oversaw,overseen;undertake:undertook,undertaken;" +
    "child:children;man:men;woman:women;person:people;foot:feet;tooth:teeth;mouse:mice;goose:geese;" +
    "ox:oxen;life:lives;wife:wives;knife:knives;leaf:leaves;wolf:wolves;half:halves;self:selves;" +
    "analysis:analyses;crisis:crises;thesis:theses;hypothesis:hypotheses;phenomenon:phenomena;" +
    "criterion:criteria;datum:data;medium:media;bacterium:bacteria;index:indices;appendix:appendices;" +
    "good:better,best;bad:worse,worst;well:better,best;far:further,farther,furthest,farthest;" +
    "little:less,least;much:more,most;many:more,most;old:elder,eldest";

  const NOUN_BASES = new Set(
    "child man woman foot tooth mouse goose ox life wife knife leaf wolf half self analysis crisis thesis hypothesis phenomenon criterion datum medium bacterium appendix".split(" ")
  );
  const IRREGULAR = new Map(); // form -> [base forms]
  const NOUN_PLURALS = new Set(); // forms that are definitely the plural of a noun
  for (const part of IRREGULAR_RAW.split(";")) {
    const [base, forms] = part.split(":");
    for (const f of forms.split(",")) {
      if (!IRREGULAR.has(f)) IRREGULAR.set(f, []);
      IRREGULAR.get(f).push(base);
      if (NOUN_BASES.has(base)) NOUN_PLURALS.add(f);
    }
  }

  const VOWELS = /[aeiou]/;

  Wordbook.Lemma = {
    // Irregular forms: { bases, plural } or null. plural means the plural of a noun
    irregular(word) {
      const w = String(word).toLowerCase();
      const bases = IRREGULAR.get(w);
      return bases ? { bases, plural: NOUN_PLURALS.has(w) } : null;
    },

    // Irregular forms of the given base form: go -> [went, gone, ...]
    formsOf(base) {
      const out = [];
      for (const [f, bases] of IRREGULAR) if (bases.includes(String(base).toLowerCase())) out.push(f);
      return out;
    },

    // Russian base form for a word form («книге» → «книга», «читали» → «читать»).
    // The list of base forms is taken from the headwords of the downloaded Russian pack (ru → …); the form is chosen by common stem
    // (Snowball) and the longest common beginning. null — the word is already a base form or no suitable one was found.
    ruBase(word) {
      const w = String(word).toLowerCase().replace(/ё/g, "е");
      const pack = Wordbook.Packs?.current();
      if (!/^[а-я]{4,}$/.test(w) || !pack || pack.src !== "ru") return null;
      if (!pack._ruIdx) {
        const idx = new Map();
        const all = new Set();
        for (const [key, val] of pack.entries) {
          if (String(val).startsWith("→")) continue; // inflected forms are not base forms
          const l = key.toLowerCase();
          if (/^[а-яё]{3,}$/.test(l) && !all.has(l.replace(/ё/g, "е"))) {
            all.add(l.replace(/ё/g, "е"));
            const st = Wordbook.Morph.stem(l, "ru");
            if (!idx.has(st)) idx.set(st, []);
            idx.get(st).push(l);
          }
        }
        pack._ruIdx = { idx, all };
      }
      const { idx, all } = pack._ruIdx;
      const yo = (x) => x.replace(/ё/g, "е");
      if (all.has(w)) return null; // already a base form
      let best = null;
      let bestScore = -1;
      for (const l of idx.get(Wordbook.Morph.stem(w, "ru")) || []) {
        const a = yo(l);
        let k = 0;
        while (k < a.length && k < w.length && a[k] === w[k]) k++;
        if (k < 3 || a.length > w.length + 3) continue;
        let score = k * 10 - Math.abs(a.length - w.length);
        if (/(ой|ая|ое|ые|ого|ому|ым|ых|ую|ыми|ими|ий|ей|яя|ее)$/.test(w) && /(ый|ий|ой)$/.test(a)) score += 15; // adjective -> adjective
        if (score > bestScore) {
          best = l;
          bestScore = score;
        }
      }
      return best;
    },

    // Dictionary form of a Russian word from an "in context" translation: via the word list, otherwise via adjective endings
    ruDictForm(word) {
      const w = String(word);
      const lw = w.toLowerCase();
      const adj = lw.match(/^([а-яё]{3,}?)(ые|ого|ому|ыми|ых|ым)$/);
      if (adj) return adj[1] + "ый";
      const adj2 = lw.match(/^([а-яё]{3,}?)(ие|ими|их|им)$/); // -ие/-их/-им/-ими: after г, к, х, ж, ч, ш, щ — «ий»
      if (adj2 && /[гкхжчшщ]$/.test(adj2[1])) {
        const b = this.ruBase(w); // «плохие» -> «плохой», «тихие» -> «тихий»: the stress is not visible, so we consult the dictionary
        return b && /(ий|ой)$/.test(b) ? b : adj2[1] + "ий";
      }
      return this.ruBase(w) || w;
    },

    // Returns base-form candidates, the word itself first
    candidates(word) {
      const w = String(word).toLowerCase();
      const out = [w];
      const add = (c) => {
        if (c && c.length >= 2 && !out.includes(c)) out.push(c);
      };

      for (const b of IRREGULAR.get(w) || []) add(b);

      // possessive case and contractions
      if (/['’]s$/.test(w)) add(w.replace(/['’]s$/, ""));
      if (/s['’]$/.test(w)) add(w.replace(/['’]$/, ""));

      // plural / 3rd person singular
      if (/ies$/.test(w)) add(w.slice(0, -3) + "y");
      if (/ves$/.test(w)) {
        add(w.slice(0, -3) + "f");
        add(w.slice(0, -3) + "fe");
      }
      if (/(s|x|z|ch|sh|o)es$/.test(w)) add(w.slice(0, -2));
      if (/es$/.test(w)) add(w.slice(0, -1)); // "makes" -> "make"
      if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));

      // -ed
      if (/ied$/.test(w)) add(w.slice(0, -3) + "y");
      if (/ed$/.test(w)) {
        const s = w.slice(0, -2);
        add(s);
        add(s + "e");
        if (/([^aeiou])\1$/.test(s)) add(s.slice(0, -1)); // stopped -> stop
      }

      // -ing
      if (/ying$/.test(w)) add(w.slice(0, -4) + "ie"); // dying -> die
      if (/ing$/.test(w) && w.length > 4) {
        const s = w.slice(0, -3);
        if (VOWELS.test(s)) {
          add(s);
          add(s + "e");
          if (/([^aeiou])\1$/.test(s)) add(s.slice(0, -1)); // running -> run
        }
      }

      // degrees of comparison
      if (/ier$|iest$/.test(w)) add(w.replace(/ier$|iest$/, "y"));
      if (/er$/.test(w)) {
        add(w.slice(0, -2));
        add(w.slice(0, -1));
        if (/([^aeiou])\1er$/.test(w)) add(w.slice(0, -3));
      }
      if (/est$/.test(w)) {
        add(w.slice(0, -3));
        add(w.slice(0, -2));
        if (/([^aeiou])\1est$/.test(w)) add(w.slice(0, -4));
      }

      // adverbs
      if (/ily$/.test(w)) add(w.slice(0, -3) + "y");
      if (/ly$/.test(w)) add(w.slice(0, -2));
      if (/ally$/.test(w)) add(w.slice(0, -4));

      return out;
    },
  };
})();
