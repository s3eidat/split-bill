/* Split Bill — all sums in integer cents; remainders go out by largest remainder so shares always add up. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$;
  var KEY = "split.v1";

  function num(v) {
    v = String(v == null ? "" : v)
      .replace(/[٠-٩]/g, function (d) { return d.charCodeAt(0) - 0x660; })
      .replace(/[۰-۹]/g, function (d) { return d.charCodeAt(0) - 0x6F0; })
      .replace(/٫/g, ".").replace(/[,\s_٬]/g, "");
    return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(v) ? parseFloat(v) : NaN;
  }
  function cents(v) { var n = num(v); return n > 0 ? Math.round(n * 100) : 0; }

  // Split `total` cents in proportion to `weights`; the result always sums to `total` exactly.
  function allocate(total, weights) {
    var sum = weights.reduce(function (a, b) { return a + b; }, 0);
    if (!sum) return weights.map(function () { return 0; });
    var parts = weights.map(function (w, i) { var exact = total * w / sum; return { i: i, v: Math.floor(exact), r: exact - Math.floor(exact) }; });
    var left = total - parts.reduce(function (a, p) { return a + p.v; }, 0);
    parts.slice().sort(function (a, b) { return b.r - a.r || a.i - b.i; }).slice(0, left).forEach(function (p) { p.v++; });
    return parts.map(function (p) { return p.v; });
  }

  function roundUp(c, step) { return step ? Math.ceil(c / step) * step : c; }

  // o: {subs: [cents per person], taxPct, tipPct, tipOnTax, step, even: split the grand total evenly}
  function compute(o) {
    var sub = o.subs.reduce(function (a, b) { return a + b; }, 0);
    var tax = Math.round(sub * o.taxPct / 100);
    var tip = Math.round((o.tipOnTax ? sub + tax : sub) * o.tipPct / 100);
    var taxes = allocate(tax, o.subs), tips = allocate(tip, o.subs);
    var shares = o.even ? allocate(sub + tax + tip, o.subs.map(function () { return 1; })) : o.subs.map(function (s, i) { return s + taxes[i] + tips[i]; });
    var pays = shares.map(function (s) { return roundUp(s, o.step); });
    var collected = pays.reduce(function (a, b) { return a + b; }, 0);
    return { sub: sub, tax: tax, tip: tip, total: sub + tax + tip, taxes: taxes, tips: tips, shares: shares, pays: pays, collected: collected };
  }

  // Item subtotals per person: each item split evenly between the people who shared it (none chosen = everyone).
  function itemSubs(people, items) {
    var subs = people.map(function () { return 0; });
    items.forEach(function (it) {
      var c = cents(it.price);
      var idx = people.map(function (p, i) { return it.who.indexOf(p.id) >= 0 ? i : -1; }).filter(function (i) { return i >= 0; });
      if (!idx.length) idx = people.map(function (p, i) { return i; });
      allocate(c, idx.map(function () { return 1; })).forEach(function (v, k) { subs[idx[k]] += v; });
    });
    return subs;
  }

  // ---------- state ----------
  function fresh() {
    return { mode: "simple", bill: "", n: 2, tip: "10", tipCustom: "", tipOnTax: false, tax: "", round: "0", cur: "",
      people: [{ id: 1, name: "Person 1" }, { id: 2, name: "Person 2" }], items: [{ id: 3, name: "", price: "", who: [] }], seq: 4 };
  }
  var st = S3.store(KEY);
  if (!st || !Array.isArray(st.people) || !Array.isArray(st.items)) st = fresh();
  function save() { S3.store(KEY, st); }

  function cur() { return (st.cur || "").trim(); }
  function money(c) {
    var s = (c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return cur() ? (/^[A-Za-z]{2,}$/.test(cur()) ? s + " " + cur() : cur() + s) : s;
  }
  function tipPct() { var c = num(st.tipCustom); return st.tipCustom.trim() && c >= 0 ? c : +st.tip; }

  // ---------- editor ----------
  function seg(el, value, onPick) {
    $$("button", el).forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.v === value));
      b.addEventListener("click", function () {
        $$("button", el).forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        onPick(b.dataset.v);
      });
    });
  }

  function drawPeople() {
    var box = $("#ppl"); box.innerHTML = "";
    st.people.forEach(function (p) {
      var inp = S3.h("input", { value: p.name, "aria-label": "Name", maxlength: "24", dir: "auto",
        oninput: function () { p.name = inp.value; $$('.who button[data-pid="' + p.id + '"]').forEach(function (b) { b.textContent = p.name || "?"; }); calc(); } });
      box.appendChild(S3.h("span", { "class": "person" }, [inp,
        S3.h("button", { type: "button", "class": "btn ghost icon", "aria-label": "Remove " + p.name, disabled: st.people.length <= 1, onclick: function () {
          st.people = st.people.filter(function (x) { return x !== p; });
          st.items.forEach(function (it) { it.who = it.who.filter(function (id) { return id !== p.id; }); });
          drawAll();
        }, html: '<svg class="i"><use href="#i-x"/></svg>' })]));
    });
  }

  function drawItems() {
    var box = $("#itm"); box.innerHTML = "";
    st.items.forEach(function (it) {
      var name = S3.h("input", { "class": "input name", value: it.name, placeholder: "Item", "aria-label": "Item name", dir: "auto", oninput: function () { it.name = name.value; calc(); } });
      var price = S3.h("input", { "class": "input price", value: it.price, placeholder: "Price", inputmode: "decimal", "aria-label": "Item price", oninput: function () { it.price = price.value; calc(); } });
      var who = S3.h("div", { "class": "who" });
      st.people.forEach(function (p) {
        var on = it.who.indexOf(p.id) >= 0;
        who.appendChild(S3.h("button", { type: "button", "data-pid": p.id, "aria-pressed": String(on), onclick: function () {
          var k = it.who.indexOf(p.id);
          if (k >= 0) it.who.splice(k, 1); else it.who.push(p.id);
          drawItems(); calc();
        } }, [p.name || "?"]));
      });
      if (!it.who.length) who.appendChild(S3.h("span", { "class": "all", text: "shared by everyone" }));
      box.appendChild(S3.h("div", { "class": "item" }, [
        S3.h("div", { "class": "row" }, [name, price,
          S3.h("button", { type: "button", "class": "btn ghost icon", "aria-label": "Remove item", onclick: function () {
            st.items = st.items.filter(function (x) { return x !== it; }); drawItems(); calc();
          }, html: '<svg class="i"><use href="#i-trash"/></svg>' })]),
        who]));
    });
    if (!st.items.length) box.appendChild(S3.h("div", { "class": "empty", text: "No items yet. Add what you ordered." }));
  }

  function drawAll() { drawPeople(); drawItems(); calc(); }

  // ---------- results ----------
  function stat(label, value) { return "<div><dt>" + S3.esc(label) + "</dt><dd>" + S3.esc(value) + "</dd></div>"; }

  function calc() {
    save();
    var simple = st.mode === "simple", n = Math.max(1, Math.min(100, Math.round(num(st.n)) || 1));
    var names = simple ? null : st.people.map(function (p, i) { return (p.name || "").trim() || "Person " + (i + 1); });
    var subs = simple ? allocate(cents(st.bill), Array(n).fill(1)) : itemSubs(st.people, st.items);
    var taxPct = Math.max(0, num(st.tax) || 0), tp = Math.max(0, tipPct() || 0);
    var r = compute({ subs: subs, taxPct: taxPct, tipPct: tp, tipOnTax: st.tipOnTax, step: +st.round, even: simple });
    var hero = $("#hero"), warn = $("#warn");
    if (!r.sub) {
      hero.innerHTML = "<b>" + S3.esc(money(0)) + "</b><span>" + (simple ? "Enter the bill amount" : "Add items with prices") + "</span>";
      $("#stats").innerHTML = ""; $("#per").innerHTML = ""; $("#per-wrap").hidden = true; warn.hidden = true;
      $("#summary").textContent = ""; state.text = ""; return;
    }
    if (simple) {
      var lo = Math.min.apply(null, r.pays), hi = Math.max.apply(null, r.pays);
      hero.innerHTML = "<b>" + S3.esc(money(hi)) + "</b><span>" + (lo === hi ? "each, " + n + (n === 1 ? " person" : " people") :
        "for " + r.pays.filter(function (x) { return x === hi; }).length + " of " + n + " people, " + S3.esc(money(lo)) + " for the rest (so it adds up exactly)") + "</span>";
    } else {
      hero.innerHTML = "<b>" + S3.esc(money(r.collected)) + "</b><span>total, split between " + st.people.length + " people</span>";
    }
    $("#stats").innerHTML = stat("Subtotal", money(r.sub)) + stat("Tax / service " + taxPct + "%", money(r.tax)) + stat("Tip " + tp + "%", money(r.tip)) + stat("Total", money(r.total)) +
      (r.collected > r.total ? stat("Collected after rounding", money(r.collected)) : "");
    var extra = r.collected - r.total;
    if (!simple) {
      $("#per-wrap").hidden = false;
      $("#per").innerHTML = '<thead><tr><th>Name</th><th class="num">Items</th><th class="num">Tax + tip</th><th class="num">Pays</th></tr></thead><tbody>' +
        names.map(function (nm, i) {
          return "<tr><td>" + S3.esc(nm) + '</td><td class="num">' + S3.esc(money(subs[i])) + '</td><td class="num">' + S3.esc(money(r.taxes[i] + r.tips[i])) +
            '</td><td class="num"><b>' + S3.esc(money(r.pays[i])) + "</b></td></tr>";
        }).join("") + "</tbody>";
    } else { $("#per-wrap").hidden = true; }
    var unpriced = simple ? 0 : st.items.filter(function (it) { return it.name.trim() && !cents(it.price); }).length;
    warn.hidden = !unpriced;
    warn.textContent = unpriced ? unpriced + (unpriced === 1 ? " item has" : " items have") + " no price yet." : "";
    var lines = ["🧾 *Bill split*" + (simple ? " — " + n + (n === 1 ? " person" : " people") : "")];
    lines.push("Subtotal: " + money(r.sub));
    if (r.tax) lines.push("Tax/service " + taxPct + "%: " + money(r.tax));
    if (r.tip) lines.push("Tip " + tp + "%: " + money(r.tip));
    lines.push("Total: *" + money(r.total) + "*", "");
    if (simple) {
      var counts = {};
      r.pays.forEach(function (p) { counts[p] = (counts[p] || 0) + 1; });
      var keys = Object.keys(counts).map(Number).sort(function (a, b) { return b - a; });
      lines.push(keys.length === 1 ? "Each pays: *" + money(keys[0]) + "*" : keys.map(function (k) { return counts[k] + " × *" + money(k) + "*"; }).join(" + "));
    } else {
      names.forEach(function (nm, i) { lines.push("• " + nm + ": *" + money(r.pays[i]) + "*"); });
    }
    if (extra > 0) lines.push("", "(Rounded up: " + money(extra) + " extra, add it to the tip)");
    state.text = lines.join("\n");
    $("#summary").textContent = state.text;
  }
  var state = { text: "" };

  function applyMode() {
    $("#simple").hidden = st.mode !== "simple"; $("#items").hidden = st.mode === "simple";
    if (st.mode !== "simple") { drawPeople(); drawItems(); }
    calc();
  }

  function load() {
    $("#bill").value = st.bill; $("#people").value = st.n; $("#tip-custom").value = st.tipCustom; $("#tip-on-tax").checked = !!st.tipOnTax;
    $("#tax").value = st.tax; $("#round").value = st.round; $("#cur").value = st.cur;
    $$("#mode button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === st.mode)); });
    $$("#tip button").forEach(function (b) { b.setAttribute("aria-pressed", String(!st.tipCustom.trim() && b.dataset.v === st.tip)); });
    applyMode();
  }

  // ---------- wiring ----------
  seg($("#mode"), st.mode, function (v) { st.mode = v; applyMode(); });
  seg($("#tip"), st.tipCustom.trim() ? "" : st.tip, function (v) { st.tip = v; st.tipCustom = ""; $("#tip-custom").value = ""; calc(); });
  $("#tip-custom").addEventListener("input", function () {
    st.tipCustom = this.value;
    $$("#tip button").forEach(function (b) { b.setAttribute("aria-pressed", String(!st.tipCustom.trim() && b.dataset.v === st.tip)); });
    calc();
  });
  $("#bill").addEventListener("input", function () { st.bill = this.value; calc(); });
  $("#people").addEventListener("input", function () { st.n = this.value; calc(); });
  $("#minus").addEventListener("click", function () { st.n = Math.max(1, (Math.round(num(st.n)) || 1) - 1); $("#people").value = st.n; calc(); });
  $("#plus").addEventListener("click", function () { st.n = Math.min(100, (Math.round(num(st.n)) || 0) + 1); $("#people").value = st.n; calc(); });
  $("#tip-on-tax").addEventListener("change", function () { st.tipOnTax = this.checked; calc(); });
  $("#tax").addEventListener("input", function () { st.tax = this.value; calc(); });
  $("#round").addEventListener("change", function () { st.round = this.value; calc(); });
  $("#cur").addEventListener("input", function () { st.cur = this.value; calc(); });
  $("#add-person").addEventListener("click", function () {
    if (st.people.length >= 30) return S3.toast("That's a big table — 30 people max", "error");
    st.people.push({ id: st.seq++, name: "Person " + (st.people.length + 1) }); drawAll();
    var ins = $$("#ppl input"); ins[ins.length - 1].select();
  });
  $("#add-item").addEventListener("click", function () {
    st.items.push({ id: st.seq++, name: "", price: "", who: [] }); drawItems(); calc();
    var ins = $$("#itm .name"); ins[ins.length - 1].focus();
  });
  $("#reset").addEventListener("click", function () { var m = st.mode; st = fresh(); st.mode = m; load(); });
  $("#copy").addEventListener("click", function () {
    if (!state.text) return S3.toast("Enter the bill first", "error");
    S3.copy(state.text, "Summary copied"); S3.done();
  });
  load();

  window.S3_DEMO = function () {
    st = fresh();
    st.mode = "items"; st.tip = "10"; st.tax = "16"; st.round = "0"; st.cur = "JOD";
    st.people = [{ id: 1, name: "Sara" }, { id: 2, name: "Omar" }, { id: 3, name: "Lina" }];
    st.items = [
      { id: 4, name: "Mansaf (large)", price: "18", who: [] },
      { id: 5, name: "Mixed grill", price: "14.5", who: [1, 2] },
      { id: 6, name: "Fattoush", price: "4.25", who: [3] },
      { id: 7, name: "Lemon mint ×3", price: "7.5", who: [] }];
    st.seq = 8;
    load();
  };

  window.S3_SELFTEST = function () {
    var a = allocate(1000, [1, 1, 1]);
    var s = compute({ subs: allocate(10000, [1, 1, 1]), taxPct: 0, tipPct: 10, tipOnTax: false, step: 0, even: true }); // 110.00 / 3
    var it = itemSubs([{ id: 1 }, { id: 2 }], [{ price: "12", who: [] }, { price: "6", who: [1] }]);       // A 12, B 6
    var t = compute({ subs: it, taxPct: 10, tipPct: 0, tipOnTax: false, step: 0 });
    var tt = compute({ subs: [10000], taxPct: 16, tipPct: 10, tipOnTax: true, step: 0 });                 // tip on 116 = 11.60
    var rr = compute({ subs: allocate(10000, [1, 1, 1]), taxPct: 0, tipPct: 0, tipOnTax: false, step: 100, even: true }); // 33.34 → 34
    return a.join() === "334,333,333" &&
      s.total === 11000 && s.pays.join() === "3667,3667,3666" && s.collected === 11000 &&
      it.join() === "1200,600" && t.pays.join() === "1320,660" &&
      tt.tip === 1160 && tt.total === 12760 &&
      rr.pays.join() === "3400,3400,3400" && rr.collected - rr.total === 200 &&
      allocate(5, [0, 0]).join() === "0,0" && cents("12.345") === 1235;
  };
})();
