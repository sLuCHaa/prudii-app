(function () {
  "use strict";

  var PALETTE = ["#e5684f", "#3aa86b", "#5a73d6", "#9b5bd1", "#d99a2b", "#2b97ab", "#c2557a", "#6b7a8f"];
  var PAGE = 200;
  var NEAR_END = 400;
  var HINT_CAP = 500;

  function colorFor(email) {
    var e = String(email || "").toLowerCase();
    var sum = 0;
    for (var i = 0; i < e.length; i++) sum += e.charCodeAt(i);
    return PALETTE[sum % 8];
  }

  function firstLetter(word) {
    var chars = Array.from(word);
    for (var i = 0; i < chars.length; i++) {
      if (/[\p{L}\p{N}]/u.test(chars[i])) return chars[i];
    }
    return "";
  }

  function initials(name, email) {
    var src = String(name || "").trim() ? name : String(email || "").split("@")[0];
    var words = String(src)
      .split(/[\s._-]+/)
      .filter(function (w) {
        return firstLetter(w) !== "";
      });
    if (!words.length) return "?";
    var out = firstLetter(words[0]);
    if (words.length > 1) out += firstLetter(words[words.length - 1]);
    return out.toUpperCase();
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function safeFormat(options, lang) {
    try {
      return new Intl.DateTimeFormat(lang, options);
    } catch (e) {
      return new Intl.DateTimeFormat(undefined, options);
    }
  }

  function readLabels() {
    var node = document.getElementById("prudii-labels");
    if (!node) return {};
    try {
      return JSON.parse(node.textContent || "{}");
    } catch (e) {
      return {};
    }
  }

  function formatBytes(n, lang) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return Math.round(n / 1024) + " KB";
    var nf = new Intl.NumberFormat(lang, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
    if (n < 1073741824) return nf.format(n / 1048576) + " MB";
    return nf.format(n / 1073741824) + " GB";
  }

  function initIndex() {
    var data = window.PRUDII_EXPORT || {};
    var labels = readLabels();
    var lang = labels.lang || document.documentElement.lang || undefined;
    var side = document.getElementById("side");
    var list = document.getElementById("list");
    var rowsBox = document.getElementById("rows");
    var hints = document.getElementById("hints");
    var meta = document.getElementById("meta");
    var search = document.getElementById("search");
    var accounts = data.accounts || [];
    var folders = [];
    var monthFmt = safeFormat({ month: "long", year: "numeric" }, lang);
    var dayFmt = safeFormat({ day: "numeric", month: "short" }, lang);
    var fullFmt = safeFormat({ day: "numeric", month: "short", year: "numeric" }, lang);
    var numFmt = new Intl.NumberFormat(lang);

    function count(n, one, other) {
      return String(n === 1 ? one || "" : other || "").replace("{count}", numFmt.format(n));
    }

    var total = 0;
    accounts.forEach(function (acc) {
      (acc.folders || []).forEach(function (f) {
        total += (f.mails || []).length;
        folders.push({ id: f.id, name: f.name, account: acc, mails: f.mails || [], link: null });
      });
    });

    var created = new Date(data.createdAt);
    var metaParts = [];
    if (!isNaN(created.getTime())) metaParts.push(safeFormat({ dateStyle: "long" }, lang).format(created));
    metaParts.push(count(accounts.length, labels.accountsOne, labels.accountsOther));
    metaParts.push(count(total, labels.mailsOne, labels.mailsOther));
    meta.textContent = metaParts.join(" · ");
    if (search && labels.searchPlaceholder) search.placeholder = labels.searchPlaceholder;

    var view = { items: [], shown: 0, lastMonth: null, full: false };
    var current = null;

    function entryTime(e) {
      if (e._t === undefined) e._t = Date.parse(e.d);
      return e._t;
    }

    function buildRow(item, full) {
      var e = item.e;
      var node = e.h ? el("a", "row") : el("div", "row dead");
      if (e.h) node.setAttribute("href", e.h);
      var av = el("div", "av", initials(e.f, e.e));
      av.style.background = colorFor(e.e);
      node.appendChild(av);
      node.appendChild(el("div", "from", e.f || e.e));
      var subj = el("div", "subj");
      subj.appendChild(document.createTextNode(e.s || labels.noSubject || ""));
      if (e.p) subj.appendChild(el("em", null, " – " + e.p));
      if (item.where) subj.appendChild(el("span", "where", item.where));
      node.appendChild(subj);
      if (e.a) node.appendChild(el("span", "clip", "📎"));
      var t = entryTime(e);
      node.appendChild(el("div", "date", isNaN(t) ? "" : (full ? fullFmt : dayFmt).format(new Date(t))));
      return node;
    }

    function renderMore() {
      var end = Math.min(view.items.length, view.shown + PAGE);
      var frag = document.createDocumentFragment();
      for (var i = view.shown; i < end; i++) {
        var item = view.items[i];
        var t = entryTime(item.e);
        var key = isNaN(t) ? "" : String(new Date(t).getFullYear() * 12 + new Date(t).getMonth());
        if (key !== view.lastMonth) {
          view.lastMonth = key;
          if (key) frag.appendChild(el("div", "month", monthFmt.format(new Date(t))));
        }
        frag.appendChild(buildRow(item, view.full));
      }
      view.shown = end;
      rowsBox.appendChild(frag);
    }

    function show(items, full, header, emptyText) {
      view = { items: items, shown: 0, lastMonth: null, full: full };
      rowsBox.textContent = "";
      if (header) rowsBox.appendChild(el("div", "results", header));
      if (!items.length) rowsBox.appendChild(el("div", "empty", emptyText || ""));
      renderMore();
      list.scrollTop = 0;
    }

    function wrap(entries, where) {
      return entries.map(function (e) {
        return { e: e, where: where };
      });
    }

    function select(id) {
      var f = folders.filter(function (x) {
        return x.id === id;
      })[0];
      if (!f) return;
      current = f;
      folders.forEach(function (x) {
        if (x.link) x.link.className = x === f ? "f on" : "f";
      });
      hints.hidden = false;
      show(wrap(f.mails, null), false, null, labels.emptyFolder);
    }

    function initialFolder() {
      var wanted = decodeURIComponent((window.location.hash || "").replace(/^#/, ""));
      var hit = folders.filter(function (x) {
        return x.id === wanted;
      })[0];
      if (hit) return hit;
      return (
        folders.filter(function (x) {
          return x.mails.length > 0;
        })[0] || folders[0]
      );
    }

    var lastAccount = null;
    folders.forEach(function (f) {
      if (f.account !== lastAccount) {
        lastAccount = f.account;
        side.appendChild(el("div", "acc", f.account.email || f.account.name));
      }
      var link = el("a", "f");
      link.setAttribute("href", "#" + encodeURIComponent(f.id));
      link.appendChild(el("span", null, f.name));
      link.appendChild(el("i", null, numFmt.format(f.mails.length)));
      link.addEventListener("click", function (ev) {
        ev.preventDefault();
        if (search) search.value = "";
        try {
          window.history.replaceState(null, "", "#" + encodeURIComponent(f.id));
        } catch (e) {
          window.location.hash = encodeURIComponent(f.id);
        }
        select(f.id);
      });
      f.link = link;
      side.appendChild(link);
    });

    function hintBlock(title, entries) {
      if (!entries || !entries.length) return;
      var box = el("details", "hint");
      box.appendChild(el("summary", null, title + " (" + numFmt.format(entries.length) + ")"));
      var filled = false;
      box.addEventListener("toggle", function () {
        if (!box.open || filled) return;
        filled = true;
        entries.slice(0, HINT_CAP).forEach(function (e) {
          box.appendChild(buildRow({ e: e, where: null }, true));
        });
      });
      hints.appendChild(box);
    }
    hintBlock(labels.localCopyTitle, data.localCopy);
    hintBlock(labels.failedTitle, data.failed);

    function keyOf(e) {
      if (e._k === undefined) e._k = ((e.s || "") + "\n" + (e.f || "") + "\n" + (e.e || "")).toLowerCase();
      return e._k;
    }

    function runSearch() {
      var q = search.value.trim().toLowerCase();
      if (!q) {
        if (current) select(current.id);
        return;
      }
      var hits = [];
      folders.forEach(function (f) {
        var where = (f.account.email || f.account.name) + " · " + f.name;
        f.mails.forEach(function (e) {
          if (keyOf(e).indexOf(q) !== -1) hits.push({ e: e, where: where });
        });
      });
      hits.sort(function (a, b) {
        return (entryTime(b.e) || 0) - (entryTime(a.e) || 0);
      });
      hints.hidden = true;
      show(hits, true, count(hits.length, labels.mailsOne, labels.mailsOther), labels.noResults);
    }
    if (search) search.addEventListener("input", runSearch);

    function onScroll() {
      if (view.shown >= view.items.length) return;
      var own = /(auto|scroll)/.test(window.getComputedStyle(list).overflowY);
      var remaining = own
        ? list.scrollHeight - list.scrollTop - list.clientHeight
        : list.getBoundingClientRect().bottom - window.innerHeight;
      if (remaining < NEAR_END) renderMore();
    }
    list.addEventListener("scroll", onScroll);
    window.addEventListener("scroll", onScroll);
    window.addEventListener("hashchange", function () {
      var f = initialFolder();
      if (f && (!current || f.id !== current.id) && !(search && search.value.trim())) select(f.id);
    });

    var start = initialFolder();
    if (start) select(start.id);
    else show([], false, null, labels.emptyFolder);
  }

  function fitFrame(frame) {
    function fit() {
      try {
        var doc = frame.contentDocument;
        if (!doc || !doc.documentElement) return;
        frame.style.minHeight = "0";
        frame.style.height = "0";
        frame.style.height = doc.documentElement.scrollHeight + "px";
      } catch (e) {
        frame.style.minHeight = "";
      }
    }
    frame.addEventListener("load", function () {
      fit();
      try {
        frame.contentDocument.addEventListener("load", fit, true);
      } catch (e) {
        return;
      }
    });
    window.addEventListener("resize", fit);
    fit();
  }

  function initMail() {
    var lang = document.documentElement.lang || undefined;
    var fmt = safeFormat({ dateStyle: "full", timeStyle: "short" }, lang);
    Array.prototype.forEach.call(document.querySelectorAll("time[datetime]"), function (t) {
      var d = new Date(t.getAttribute("datetime"));
      if (!isNaN(d.getTime())) t.textContent = fmt.format(d);
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-bytes]"), function (s) {
      var n = Number(s.getAttribute("data-bytes"));
      if (isFinite(n)) s.textContent = formatBytes(n, lang);
    });
    Array.prototype.forEach.call(document.querySelectorAll("iframe.mail-body"), fitFrame);
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (document.getElementById("app")) initIndex();
    else initMail();
  });
})();
