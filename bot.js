(function () {
  "use strict";

  // All settings come from config.js.
  var CFG = window.BOT_CONFIG || {};

  var LABELS = {
    mail_in_deadline: "When a mailed ballot must be postmarked or received",
    request_deadline: "Last day to request a ballot",
    request_process: "Who can vote by mail and how to get a ballot",
    id_required: "ID, witness, notary or signature rules"
  };
  var REQUIRED_HEADERS = ["state_id", "state_name"];
  // Two-letter words that are also common English words; never read these as state codes unless typed in capitals.
  var AMBIGUOUS = ["me", "or", "in", "hi", "ok", "oh", "id"];

  var states = [];
  var lastStates = [];
  var hasLoadedOnce = false;

  var logEl = document.getElementById("log");
  var formEl = document.getElementById("askForm");
  var inputEl = document.getElementById("askInput");
  var loadedEl = document.getElementById("loadedAt");

  /* ---------- small DOM helpers (text is always set with textContent) ---------- */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function addMessage(cls) {
    var box = el("div", "msg " + cls);
    logEl.appendChild(box);
    return box;
  }

  function scrollDown() {
    logEl.scrollTop = logEl.scrollHeight;
  }

  function say(text) {
    addMessage("bot").appendChild(el("p", null, text));
    scrollDown();
  }

  function clockTime(date) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function prettyDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return iso || "";
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
  }

  /* ---------- CSV parsing (handles quotes, commas, doubled quotes, line breaks in cells) ---------- */

  function parseCSV(text) {
    var table = [], row = [], cell = "", inQuotes = false, i, c;
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    for (i = 0; i < text.length; i++) {
      c = text.charAt(i);
      if (inQuotes) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { cell += '"'; i++; }
          else inQuotes = false;
        } else {
          cell += c;
        }
      } else if (c === '"' && cell === "") {
        inQuotes = true;
      } else if (c === ",") {
        row.push(cell); cell = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text.charAt(i + 1) === "\n") i++;
        row.push(cell); cell = "";
        table.push(row); row = [];
      } else {
        cell += c;
      }
    }
    if (cell !== "" || row.length) { row.push(cell); table.push(row); }
    return table;
  }

  // Turn the table into one object per state, matching columns by header name.
  function tableToStates(table) {
    if (!table.length) throw new Error("The sheet is empty.");
    var heads = table[0].map(function (h) { return h.trim().toLowerCase(); });
    REQUIRED_HEADERS.forEach(function (h) {
      if (heads.indexOf(h) === -1) throw new Error('The sheet has no "' + h + '" column.');
    });
    var out = [];
    for (var r = 1; r < table.length; r++) {
      var cells = table[r];
      var blank = cells.every(function (c) { return c.trim() === ""; });
      if (blank) continue;
      var obj = {};
      for (var j = 0; j < heads.length; j++) {
        obj[heads[j]] = (cells[j] || "").trim();
      }
      if (obj.state_id && obj.state_name) out.push(obj);
    }
    return out;
  }

  /* ---------- loading and refreshing ---------- */

  function sheetUrl() {
    var url = CFG.SHEET_CSV_URL;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
    return url + (url.indexOf("?") === -1 ? "?" : "&") + "cb=" + Date.now();
  }

  function loadData() {
    var url = sheetUrl();
    if (!url) {
      loadedEl.textContent = "No data link is set yet.";
      if (!hasLoadedOnce) say("This bot is not set up yet. Add the published CSV link to SHEET_CSV_URL in config.js.");
      return Promise.resolve();
    }
    return fetch(url, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("The sheet returned status " + res.status + ".");
        return res.text();
      })
      .then(function (text) {
        states = tableToStates(parseCSV(text));
        loadedEl.textContent = "Data loaded at " + clockTime(new Date());
        if (!hasLoadedOnce) {
          hasLoadedOnce = true;
          welcome();
        }
      })
      .catch(function (err) {
        if (hasLoadedOnce) {
          loadedEl.textContent = "Could not refresh the data at " + clockTime(new Date()) + ". Showing the last version that loaded.";
        } else {
          loadedEl.textContent = "Data could not be loaded.";
          say("I couldn't load the data. " + err.message + " Please try again in a few minutes.");
        }
      });
  }

  function welcome() {
    var example = states.length ? "When is my ballot due in " + states[0].state_name + "?" : "";
    var text = "Hi, I'm " + CFG.NEWSROOM + "'s mail-in voting helper for the " + CFG.ELECTION + ". " +
      "Tell me your state and what you want to know: ballot deadlines, how to request a ballot, or ID and signature rules.";
    if (example) text += " For example: \"" + example + "\"";
    say(text);
  }

  /* ---------- understanding the question ---------- */

  function normalize(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  }

  // Returns matched state objects in the order they appear in the question.
  function findStates(question) {
    var found = [];
    var norm = normalize(question);
    var byLength = states.slice().sort(function (a, b) {
      return normalize(b.state_name).length - normalize(a.state_name).length;
    });

    // 1) Full names, longest first so "West Virginia" is not read as "Virginia".
    byLength.forEach(function (s) {
      var re = new RegExp("\\b" + normalize(s.state_name) + "\\b");
      var idx = norm.search(re);
      if (idx !== -1) {
        found.push({ idx: idx, state: s });
        norm = norm.replace(re, function (m) { return new Array(m.length + 1).join(" "); });
      }
    });
    if (found.length) return sortedStates(found);

    // 2) Two-letter codes: only after a word like "in" or "for", or when the whole message is the code.
    function byCode(code) {
      var c = code.toLowerCase();
      for (var i = 0; i < states.length; i++) {
        if (states[i].state_id.toLowerCase() === c) return states[i];
      }
      return null;
    }
    var whole = /^\s*([A-Za-z]{2})\s*[?.!]*\s*$/.exec(question);
    if (whole && byCode(whole[1])) return [byCode(whole[1])];

    var re2 = /\b(?:in|for|from|of|to|at|about)\s+([A-Za-z]{2})\b/gi, m;
    while ((m = re2.exec(question)) !== null) {
      var tok = m[1];
      var rest = question.slice(re2.lastIndex);
      var isCaps = tok === tok.toUpperCase();
      var atEnd = /^\s*[?.!,]*\s*$/.test(rest);
      var ok = isCaps || (atEnd && AMBIGUOUS.indexOf(tok.toLowerCase()) === -1);
      var s2 = ok ? byCode(tok) : null;
      if (s2 && !found.some(function (f) { return f.state === s2; })) {
        found.push({ idx: m.index, state: s2 });
      }
    }
    return sortedStates(found);
  }

  function sortedStates(found) {
    return found.sort(function (a, b) { return a.idx - b.idx; }).map(function (f) { return f.state; });
  }

  // Decide which fields to show. Returns null if the question names no topic.
  function pickFields(question) {
    var q = question.toLowerCase();
    var wantsId = /\bid\b|identif|witness|notar|signature|\bsign\b|license|verify|photocopy/.test(q);
    var wantsRequest = /request|apply|application|get (a|my|the) ballot|sign up|eligib|who (can|may)|qualif|absentee|excuse|obtain|first.?time|how (do|can) i (vote|get)|vote by mail|vote.?by.?mail/.test(q);
    var wantsMail = /postmark|return|mail (it )?back|send (it )?back|received|arrive|turn in|drop off|\blate\b|in time/.test(q);
    var wantsDeadline = /deadline|\bdue\b|\bwhen\b|last day|cut.?off|by what date/.test(q);
    var wantsAll = /everything|\ball\b|overview|summary|info|basics|tell me about/.test(q);
    var wantsLink = /website|\blink\b|official|\burl\b|election (office|board|division)|contact|where (do|can) i (go|find)/.test(q);

    var fields = [];
    function add(f) { if (fields.indexOf(f) === -1) fields.push(f); }

    if (wantsAll) return Object.keys(LABELS);
    if (wantsMail) add("mail_in_deadline");
    if (wantsRequest) { add("request_deadline"); add("request_process"); }
    if (wantsDeadline && !wantsMail && !wantsRequest) { add("mail_in_deadline"); add("request_deadline"); }
    if (wantsId) add("id_required");
    if (!fields.length && wantsLink) return [];
    return fields.length ? fields : null;
  }

  /* ---------- building answers ---------- */

  function showAnswer(s, fields) {
    var box = addMessage("bot answer");
    box.appendChild(el("h2", null, s.state_name + " (" + s.state_id.toUpperCase() + ")"));

    fields.forEach(function (key) {
      var item = el("div", "item");
      item.appendChild(el("strong", null, LABELS[key]));
      item.appendChild(el("p", null, s[key] || "Our reporters haven't added this yet."));
      box.appendChild(item);
    });

    var meta = el("div", "meta");
    if (s.official_link) {
      var p = el("p", null, "Official state election page: ");
      if (/^https?:\/\//i.test(s.official_link)) {
        var a = el("a", null, s.official_link);
        a.href = s.official_link;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        p.appendChild(a);
      } else {
        p.appendChild(document.createTextNode(s.official_link));
      }
      meta.appendChild(p);
    }
    if (s.last_updated) {
      meta.appendChild(el("p", null, CFG.NEWSROOM + " last checked this on " + prettyDate(s.last_updated) + ". Confirm with your state election office before you act."));
    } else {
      meta.appendChild(el("p", null, "Confirm with your state election office before you act."));
    }
    box.appendChild(meta);
    scrollDown();
  }

  function listStates() {
    return states.map(function (s) { return s.state_name; }).join(", ");
  }

  function handleQuestion(question) {
    if (!states.length) {
      say("The data isn't loaded yet. Please try again in a moment.");
      return;
    }
    var matched = findStates(question);
    var fields = pickFields(question);

    if (!matched.length) {
      // Follow-up like "What about ID?" reuses the state from the last answer.
      if (lastStates.length === 1 && fields) {
        matched = lastStates;
      } else {
        say("Which state do you vote in? I have information for: " + listStates() + ".");
        return;
      }
    }
    if (matched.length > 3) {
      say("That's a lot of states at once. Ask about up to three at a time.");
      return;
    }
    if (!fields) fields = Object.keys(LABELS);
    matched.forEach(function (s) { showAnswer(s, fields); });
    lastStates = matched;
  }

  /* ---------- start up ---------- */

  document.title = CFG.NEWSROOM + " mail-in voting help";
  document.getElementById("botTitle").textContent = CFG.NEWSROOM + " mail-in voting help";
  document.getElementById("botSub").textContent = "Answers for first-time voters in the " + CFG.ELECTION + ".";

  formEl.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = inputEl.value.trim();
    if (!text) return;
    addMessage("user").appendChild(el("p", null, text));
    inputEl.value = "";
    scrollDown();
    handleQuestion(text);
  });

  loadData();
  var minutes = Number(CFG.REFRESH_MINUTES);
  if (isFinite(minutes) && minutes > 0) {
    setInterval(loadData, minutes * 60 * 1000);
  }
})();
