/* ===== SnapyCore (logika poin, sama dengan halaman) ===== */
/* SnapyCore — logika murni & sinkron untuk program poin member Snapy.
 * Tidak menyentuh DOM, jaringan, atau db. Halaman memuat dokumen secara async,
 * menjalankan core pada snapshot, lalu menulis hasilnya. */
(function (root, factory) {
  const core = factory();
  if (typeof module === "object" && module.exports) module.exports = core;
  else root.SnapyCore = core;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULTS = Object.freeze({
    outlets: ["Cinere", "Taman Palem", "GSB2", "PIK", "Tomang"],
    // [batas bawah Rp, poin] — urut dari terbesar
    tiers: [[500000, 75], [200000, 30], [100000, 13], [50000, 6], [25000, 3], [10000, 1]],
    packages: [
      { points: 40, discount: 10000 },
      { points: 100, discount: 25000 },
      { points: 200, discount: 50000 },
      { points: 400, discount: 100000 },
    ],
    expiryMonths: 12,
    dupWindowMs: 5 * 60 * 1000,
    voidWindowMs: 10 * 60 * 1000,
    bigValue: 2000000,
    nearGap: 25000,
    tzOffsetMin: 7 * 60, // Asia/Jakarta, tanpa DST
  });

  function config(over) {
    const c = Object.assign({}, DEFAULTS, over || {});
    c.tiers = (c.tiers || DEFAULTS.tiers).slice().sort((a, b) => b[0] - a[0]);
    c.packages = (c.packages || DEFAULTS.packages).slice().sort((a, b) => a.points - b.points);
    return c;
  }

  /* ---------- Nomor HP ---------- */
  // 08…, 8…, 62…, +62… → 62xxxxxxxxxx; valid 10–15 digit
  function normPhone(v) {
    let d = String(v == null ? "" : v).replace(/\D/g, "");
    if (!d) return null;
    if (d.startsWith("62")) d = d.slice(2);
    d = d.replace(/^0+/, "");
    if (!d) return null;
    const p = "62" + d;
    if (p.length < 10 || p.length > 15) return null;
    return p;
  }
  function shardOf(phone62) { return "s" + phone62.slice(-1); }
  function prettyPhone(p62) {
    const local = "0" + String(p62).slice(2);
    return local.replace(/^(\d{4})(\d{4})(\d+)$/, "$1-$2-$3");
  }

  /* ---------- Waktu (Asia/Jakarta) ---------- */
  function jktParts(ms, c) {
    const off = (c || DEFAULTS).tzOffsetMin * 60000;
    const d = new Date(ms + off);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
  }
  function ymOf(ms, c) { const p = jktParts(ms, c); return p.y + "-" + String(p.m).padStart(2, "0"); }
  function daysIn(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m 1-12
  // Akhir hari yang sama N bulan kemudian (Jakarta), dalam ms UTC
  function expiryOf(ms, c) {
    c = c || DEFAULTS;
    const p = jktParts(ms, c);
    let y = p.y, m = p.m + c.expiryMonths;
    y += Math.floor((m - 1) / 12); m = ((m - 1) % 12) + 1;
    const d = Math.min(p.d, daysIn(y, m));
    return Date.UTC(y, m - 1, d, 23, 59, 59, 999) - c.tzOffsetMin * 60000;
  }

  /* ---------- Tiering & paket ---------- */
  function pointsFor(net, c) {
    c = c || DEFAULTS;
    for (const [min, pts] of c.tiers) if (net >= min) return pts;
    return 0;
  }
  // Selisih ke batas poin berikutnya bila ≤ nearGap
  function nearNext(net, c) {
    c = config(c);
    const asc = c.tiers.slice().sort((a, b) => a[0] - b[0]);
    for (const [min, pts] of asc) {
      if (net < min) {
        const gap = min - net;
        return gap <= c.nearGap ? { gap, points: pts, at: min } : null;
      }
    }
    return null;
  }
  // Paket yang terjangkau oleh saldo (dan nilai transaksi bila diberikan), tertinggi dulu
  function affordable(balance, value, c) {
    c = config(c);
    return c.packages
      .filter(p => p.points <= balance && (value == null || p.discount <= value))
      .sort((a, b) => b.points - a.points);
  }

  /* ---------- Ledger & FIFO ---------- */
  function activeRows(rows) {
    return (rows || [])
      .map((r, i) => ({ r, i }))
      .filter(x => x.r.status !== "VOID")
      .sort((a, b) => (Date.parse(a.r.time) - Date.parse(b.r.time)) || (a.i - b.i))
      .map(x => x.r);
  }

  // Putar ulang ledger: lot poin FIFO dengan kedaluwarsa. Saldo tidak pernah disimpan.
  function replay(rows, nowMs, c) {
    c = config(c);
    const lots = [];
    const expired = []; // {at, points, outlet}
    let shortfall = 0;
    function expireUntil(t) {
      for (const lot of lots) {
        if (lot.remaining > 0 && lot.expiresAt < t) {
          expired.push({ at: lot.expiresAt, points: lot.remaining, outlet: lot.outlet, earnedAt: lot.earnedAt });
          lot.remaining = 0;
        }
      }
    }
    for (const r of activeRows(rows)) {
      const t = Date.parse(r.time);
      expireUntil(t);
      if (r.type === "EARN" && r.points > 0) {
        lots.push({ txId: r.txId, earnedAt: t, points: r.points, remaining: r.points, expiresAt: expiryOf(t, c), outlet: r.outlet });
      } else if (r.type === "REDEEM") {
        let need = Math.abs(r.points || 0);
        for (const lot of lots) {
          if (!need) break;
          if (lot.remaining <= 0) continue;
          const take = Math.min(lot.remaining, need);
          lot.remaining -= take; need -= take;
        }
        shortfall += need;
      }
    }
    expireUntil(nowMs);
    const live = lots.filter(l => l.remaining > 0);
    const balance = live.reduce((s, l) => s + l.remaining, 0);
    let nextExpiry = null;
    if (live.length) {
      const at = Math.min(...live.map(l => l.expiresAt));
      nextExpiry = { at, points: live.filter(l => l.expiresAt === at).reduce((s, l) => s + l.remaining, 0) };
    }
    // Rincian per bulan dapat
    const byMonth = {};
    for (const l of live) {
      const k = ymOf(l.earnedAt, c);
      const b = byMonth[k] || (byMonth[k] = { month: k, points: 0, expiresFrom: l.expiresAt });
      b.points += l.remaining; b.expiresFrom = Math.min(b.expiresFrom, l.expiresAt);
    }
    const months = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
    return { balance, lots: live, nextExpiry, months, expired, shortfall };
  }

  /* ---------- Transaksi ---------- */
  function totalRedeem(redeem, c) {
    c = config(c);
    let points = 0, discount = 0;
    for (const p of c.packages) {
      const n = Math.max(0, Math.floor(Number((redeem || {})[p.points]) || 0));
      points += n * p.points; discount += n * p.discount;
    }
    return { points, discount };
  }

  function computeTx(value, redeem, balance, c) {
    c = config(c);
    value = Math.max(0, Math.round(Number(value) || 0));
    const r = totalRedeem(redeem, c);
    const errors = [];
    if (r.points > balance) errors.push("INSUFFICIENT");
    if (r.discount > value) errors.push("DISCOUNT_EXCEEDS");
    const net = Math.max(0, value - r.discount);
    const earn = pointsFor(net, c);
    return {
      value, discount: r.discount, pointsUsed: r.points, net, earn,
      after: balance - r.points + earn, near: nearNext(net, c),
      big: value > c.bigValue, errors, ok: errors.length === 0 && value > 0,
    };
  }

  // Kelompokkan baris per txId (urutan terbaru dulu)
  function transactions(rows) {
    const map = new Map();
    (rows || []).forEach((r, i) => {
      let t = map.get(r.txId);
      if (!t) { t = { txId: r.txId, time: r.time, outlet: r.outlet, kasir: r.kasir, value: r.value, net: r.net, discount: 0, earned: 0, redeemed: 0, status: r.status, idx: i }; map.set(r.txId, t); }
      if (r.type === "EARN") { t.earned = r.points; t.net = r.net; t.value = r.value; t.discount = r.discount || t.discount; }
      if (r.type === "REDEEM") { t.redeemed = Math.abs(r.points); t.discount = r.discount; }
      if (r.status === "VOID") t.status = "VOID";
      t.idx = Math.max(t.idx, i);
    });
    return [...map.values()].sort((a, b) => (Date.parse(b.time) - Date.parse(a.time)) || (b.idx - a.idx));
  }
  function lastActiveTx(rows) { return transactions(rows).find(t => t.status !== "VOID") || null; }

  function isDuplicate(rows, outlet, value, nowMs, c) {
    c = config(c);
    return transactions(rows).some(t => t.status !== "VOID" && t.outlet === outlet && t.value === value &&
      nowMs - Date.parse(t.time) >= 0 && nowMs - Date.parse(t.time) <= c.dupWindowMs);
  }

  // Aturan batal: kasir hanya transaksi aktif terakhir, ≤10 menit, outlet sama.
  function voidCheck(rows, txId, outlet, nowMs, c) {
    c = config(c);
    const last = lastActiveTx(rows);
    if (!last || last.txId !== txId) return { allowed: false, code: "NOT_LAST", needsAdmin: false };
    const age = nowMs - Date.parse(last.time);
    if (age > c.voidWindowMs) return { allowed: false, code: "TOO_OLD", needsAdmin: true };
    if (last.outlet !== outlet) return { allowed: false, code: "OTHER_OUTLET", needsAdmin: true };
    return { allowed: true };
  }

  function txIdNew(nowMs) { return "t" + nowMs.toString(36) + Math.random().toString(36).slice(2, 7); }

  /* ---------- Router ----------
   * store: { rows(phone) -> array (snapshot), config? }
   * Kembalikan { ok, rows? (dokumen ledger baru), ... } atau { ok:false, code } */
  function handle(req, store) {
    const c = config(store && store.config);
    const now = req.now != null ? req.now : Date.now();
    const phone = normPhone(req.phone);
    if (!phone) return { ok: false, code: "BAD_PHONE" };
    const rows = (store.rows(phone) || []).slice();
    const isAdmin = !!req.isAdmin;

    if (req.type === "summary") {
      const rp = replay(rows, now, c);
      return { ok: true, phone, ...rp, history: transactions(rows).slice(0, 6), last: lastActiveTx(rows), offers: affordable(rp.balance, null, c) };
    }

    if (req.type === "commit") {
      if (!req.kasir) return { ok: false, code: "NO_KASIR" };
      if (!req.outlet || !c.outlets.includes(req.outlet)) return { ok: false, code: "NO_OUTLET" };
      const before = replay(rows, now, c);
      const tx = computeTx(req.value, req.redeem, before.balance, c);
      if (tx.value <= 0) return { ok: false, code: "NO_VALUE" };
      if (tx.errors.length) return { ok: false, code: tx.errors[0] };
      if (tx.big && !req.confirmBig) return { ok: false, code: "NEED_BIG_CONFIRM" };
      if (isDuplicate(rows, req.outlet, tx.value, now, c)) {
        if (!(isAdmin && req.adminOverride)) return { ok: false, code: "DUPLICATE", needsAdmin: true };
      }
      const txId = req.txId || txIdNew(now);
      const time = new Date(now).toISOString();
      const base = { txId, time, outlet: req.outlet, kasir: req.kasir, value: tx.value, discount: tx.discount, net: tx.net, status: "ACTIVE" };
      const add = [];
      if (tx.pointsUsed > 0) add.push({ ...base, type: "REDEEM", points: -tx.pointsUsed, note: req.note || "" });
      add.push({ ...base, type: "EARN", points: tx.earn, note: (isAdmin && req.adminOverride) ? "duplikat disetujui admin" : (req.note || "") });
      const newRows = rows.concat(add);
      const after = replay(newRows, now, c);
      const crossed = c.packages.filter(p => before.balance - tx.pointsUsed < p.points && after.balance >= p.points).sort((a, b) => b.points - a.points);
      return { ok: true, phone, txId, rows: newRows, tx, before: before.balance, after: after.balance,
        promoCode: tx.discount > 0 ? "POIN-" + Math.round(tx.discount / 1000) + "K" : "", crossed, summary: after };
    }

    if (req.type === "void") {
      const chk = voidCheck(rows, req.txId, req.outlet, now, c);
      if (!chk.allowed) {
        if (chk.code === "NOT_LAST") return { ok: false, code: "NOT_LAST" };
        if (!(isAdmin && req.adminOverride)) return { ok: false, code: chk.code, needsAdmin: true };
      }
      const note = chk.allowed ? "dibatalkan kasir" : "dibatalkan, disetujui admin";
      const newRows = rows.map(r => r.txId === req.txId ? { ...r, status: "VOID", note, voidedAt: new Date(now).toISOString(), voidedBy: req.kasir || "" } : r);
      return { ok: true, phone, rows: newRows, summary: replay(newRows, now, c) };
    }

    return { ok: false, code: "BAD_REQUEST" };
  }

  /* ---------- Import data member ---------- */
  function parseTable(text) {
    text = String(text || "").replace(/^﻿/, "");
    const firstLines = text.split(/\r?\n/).slice(0, 6).join("\n");
    const tabs = (firstLines.match(/\t/g) || []).length, commas = (firstLines.match(/,/g) || []).length, semis = (firstLines.match(/;/g) || []).length;
    const delim = tabs > 0 && tabs >= commas ? "\t" : (semis > commas ? ";" : ",");
    const rows = []; let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += ch;
      } else if (ch === '"' && f === "") q = true;
      else if (ch === delim) { row.push(f); f = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(f); f = ""; rows.push(row); row = [];
      } else f += ch;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return { delim, rows: rows.filter(r => r.some(x => String(x).trim() !== "")) };
  }

  function parseDate(s) {
    s = String(s || "").trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return ymd(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
    if (m) {
      let a = +m[1], b = +m[2], y = +m[3]; if (y < 100) y += 2000;
      let d = a, mo = b;            // bawaan d/m/yyyy
      if (b > 12 && a <= 12) { d = b; mo = a; } // jelas m/d/yyyy
      return ymd(y, mo, d);
    }
    if (/^\d{5}(\.\d+)?$/.test(s)) { // serial Excel
      const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 86400000);
      return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    return "";
  }
  function ymd(y, m, d) {
    if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return "";
    return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  }

  // Hanya nama, cabang, nomor, customercode, joindate yang disimpan.
  function importMembers(text) {
    const { rows } = parseTable(text);
    const norm = s => String(s || "").trim().toLowerCase().replace(/\s+/g, "");
    let h = -1, idx = {};
    for (let i = 0; i < Math.min(6, rows.length); i++) {
      const cols = rows[i].map(norm);
      if (cols.includes("phone") && cols.includes("customername")) {
        h = i;
        const find = (...names) => { for (const n of names) { const k = cols.indexOf(n); if (k >= 0) return k; } return -1; };
        idx = { cabang: find("cabang", "outlet"), name: find("customername"), phone: find("phone"), code: find("customercode"), join: find("joindate") };
        break;
      }
    }
    if (h < 0) return { ok: false, code: "NO_HEADER" };
    const members = {}; const meta = {};
    let invalid = 0, dupMerged = 0, total = 0;
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i]; total++;
      const phone = normPhone(r[idx.phone]);
      const name = String(r[idx.name] || "").trim();
      if (!phone || !name) { invalid++; continue; }
      const join = idx.join >= 0 ? parseDate(r[idx.join]) : "";
      const rec = [name, idx.cabang >= 0 ? String(r[idx.cabang] || "").trim() : "", idx.code >= 0 ? String(r[idx.code] || "").trim() : "", join];
      if (members[phone]) {
        dupMerged++;
        if ((join || "") >= (members[phone][3] || "")) members[phone] = rec; // terbaru menang; seri → baris lebih bawah
      } else members[phone] = rec;
    }
    const byCabang = {};
    for (const p in members) { const cb = members[p][1] || "(tanpa cabang)"; byCabang[cb] = (byCabang[cb] || 0) + 1; }
    const shards = {};
    for (let d = 0; d < 10; d++) shards["s" + d] = { m: {}, n: 0 };
    for (const p in members) { const s = shards[shardOf(p)]; s.m[p] = members[p]; s.n++; }
    return { ok: true, count: Object.keys(members).length, rowsRead: total, invalid, dupMerged, byCabang, shards };
  }

  /* ---------- Rekap bulanan ---------- */
  // ledgers: { phone62: rows[] }, month "YYYY-MM"
  function monthlyReport(ledgers, month, nowMs, sales, c) {
    c = config(c);
    const out = {};
    const get = o => out[o] || (out[o] = { outlet: o, tx: 0, members: new Set(), pointsIn: 0, pointsRedeemed: 0, pointsExpired: 0, discount: 0, memberSales: 0, outletSales: 0 });
    for (const o of c.outlets) get(o);
    for (const phone in ledgers) {
      const rows = ledgers[phone] || [];
      for (const r of activeRows(rows)) {
        const t = Date.parse(r.time);
        if (ymOf(t, c) !== month) continue;
        const o = get(r.outlet);
        if (r.type === "EARN") { o.tx++; o.members.add(phone); o.pointsIn += r.points; o.memberSales += r.net; }
        if (r.type === "REDEEM") { o.pointsRedeemed += Math.abs(r.points); o.discount += r.discount; }
      }
      for (const e of replay(rows, nowMs, c).expired) {
        if (e.at <= nowMs && ymOf(e.at, c) === month) get(e.outlet).pointsExpired += e.points;
      }
    }
    const list = Object.values(out).map(o => {
      const outletSales = Number((sales || {})[o.outlet]) || 0;
      return { ...o, members: o.members.size, outletSales,
        share: outletSales > 0 ? o.memberSales / outletSales : null,
        discountPct: o.memberSales > 0 ? o.discount / o.memberSales : null };
    });
    const tot = list.reduce((a, o) => {
      for (const k of ["tx", "members", "pointsIn", "pointsRedeemed", "pointsExpired", "discount", "memberSales", "outletSales"]) a[k] += o[k];
      return a;
    }, { outlet: "Total", tx: 0, members: 0, pointsIn: 0, pointsRedeemed: 0, pointsExpired: 0, discount: 0, memberSales: 0, outletSales: 0 });
    tot.share = tot.outletSales > 0 ? tot.memberSales / tot.outletSales : null;
    tot.discountPct = tot.memberSales > 0 ? tot.discount / tot.memberSales : null;
    return { rows: list, total: tot };
  }

  function csvCell(v) { const s = String(v == null ? "" : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function ledgerCsv(ledgers, kasirName) {
    const head = ["phone", "txId", "time", "type", "outlet", "kasir", "value", "points", "discount", "net", "status", "note"];
    const lines = [head.join(",")];
    const all = [];
    for (const phone in ledgers) for (const r of ledgers[phone] || []) all.push({ phone, r });
    all.sort((a, b) => Date.parse(a.r.time) - Date.parse(b.r.time));
    for (const { phone, r } of all) {
      lines.push([phone, r.txId, r.time, r.type, r.outlet, kasirName ? kasirName(r.kasir) : r.kasir, r.value, r.points, r.discount, r.net, r.status, r.note].map(csvCell).join(","));
    }
    return lines.join("\n");
  }

  return {
    DEFAULTS, config, normPhone, shardOf, prettyPhone, jktParts, ymOf, expiryOf,
    pointsFor, nearNext, affordable, replay, computeTx, transactions, lastActiveTx,
    isDuplicate, voidCheck, handle, parseTable, parseDate, importMembers, monthlyReport, ledgerCsv, csvCell,
  };
});


/* ===================== SNAPY MEMBER POIN — Apps Script =====================
 * Pasang di Google Sheet data member: Extensions > Apps Script, paste seluruh file ini.
 * Data member dibaca dari sheet pertama (atau MEMBER_SHEET). Tab "Ledger" dan "Rekap"
 * dibuat otomatis saat pertama dipakai. Jangan ubah isi tab Ledger secara manual.
 */
const PIN_KASIR = 'GANTI_PIN_KASIR';   // PIN untuk semua kasir
const PIN_ADMIN = 'GANTI_PIN_ADMIN';   // PIN admin (rekap, unduh ledger, setujui batal/kembar)
const MEMBER_SHEET = '';               // kosong = sheet pertama yang bukan Ledger/Rekap
const LEDGER_SHEET = 'Ledger';
const REKAP_SHEET = 'Rekap';
const LEDGER_HEAD = ['phone', 'txId', 'time', 'type', 'outlet', 'kasir', 'value', 'points', 'discount', 'net', 'status', 'note', 'voidedAt', 'voidedBy'];

function doGet(e) {
  try { return out(route((e && e.parameter) || {})); }
  catch (err) { return out({ ok: false, code: 'SERVER', error: String(err && err.message || err) }); }
}

function route(p) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('fails') || 0);
  if (fails > 20) return { ok: false, code: 'LOCK', error: 'Terlalu banyak PIN salah. Coba lagi 10 menit lagi.' };
  const pin = String(p.pin || '');
  const usable = function (x) { return x && String(x).indexOf('GANTI') !== 0; };
  const role = usable(PIN_ADMIN) && pin === PIN_ADMIN ? 'admin' : usable(PIN_KASIR) && pin === PIN_KASIR ? 'kasir' : '';
  if (!role) { cache.put('fails', String(fails + 1), 600); return { ok: false, code: 'PIN', error: 'PIN salah' }; }
  const isAdmin = role === 'admin';
  let q = {};
  try { q = JSON.parse(p.p || '{}'); } catch (_) { return { ok: false, code: 'BAD_REQUEST' }; }
  const a = String(p.a || '');
  const C = SnapyCore;

  if (a === 'ping') return { ok: true, role: role, outlets: C.DEFAULTS.outlets };

  if (a === 'lookup') {
    const phone = C.normPhone(q.phone);
    if (!phone) return { ok: false, code: 'BAD_PHONE' };
    const mem = members();
    return { ok: true, phone: phone, member: mem.map[phone] || null, memberCount: mem.count, rows: ledgerFor(phone).rows, now: Date.now() };
  }

  if (a === 'commit' || a === 'void') {
    const phone = C.normPhone(q.phone);
    if (!phone) return { ok: false, code: 'BAD_PHONE' };
    const kasirName = String(q.kasirName || '').trim().slice(0, 60);
    if (!kasirName) return { ok: false, code: 'NO_KASIR' };
    if (a === 'commit' && !members().map[phone]) return { ok: false, code: 'NOT_MEMBER' };
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return { ok: false, code: 'BUSY' };
    try {
      const led = ledgerFor(phone);
      const now = Date.now();
      const req = { type: a, phone: phone, outlet: q.outlet, kasir: 'kasir:' + kasirName, now: now, isAdmin: isAdmin, adminOverride: !!q.adminOverride };
      if (a === 'commit') { req.value = q.value; req.redeem = q.redeem || {}; req.confirmBig = !!q.confirmBig; }
      else req.txId = String(q.txId || '');
      const res = C.handle(req, { rows: function () { return led.rows; } });
      if (!res.ok) return res;
      const sh = ledgerSheet();
      if (a === 'commit') {
        const add = res.rows.slice(led.rows.length).map(function (r) { return rowOut(phone, r); });
        sh.getRange(sh.getLastRow() + 1, 1, add.length, LEDGER_HEAD.length).setValues(add);
        return { ok: true, txId: res.txId, tx: res.tx, before: res.before, after: res.after, promoCode: res.promoCode, crossed: res.crossed, rows: res.rows, now: now };
      }
      res.rows.forEach(function (r, i) {
        if (r.txId !== req.txId) return;
        sh.getRange(led.rowNums[i], 11, 1, 4).setValues([[r.status, r.note || '', r.voidedAt || '', r.voidedBy || '']]);
      });
      return { ok: true, rows: res.rows, now: now };
    } finally { lock.releaseLock(); }
  }

  if (!isAdmin) return { ok: false, code: 'ADMIN_ONLY' };

  if (a === 'stats') { const m = members(); return { ok: true, count: m.count, byCabang: m.byCabang, invalid: m.invalid, dupMerged: m.dupMerged, sheet: m.sheet }; }

  if (a === 'report') {
    const month = String(q.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, code: 'BAD_MONTH' };
    const sales = salesFor(month);
    const rep = C.monthlyReport(allLedgers(), month, Date.now(), sales);
    return { ok: true, month: month, report: rep, sales: sales };
  }

  if (a === 'setSales') {
    const month = String(q.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, code: 'BAD_MONTH' };
    const sh = sheetNamed(REKAP_SHEET, ['month', 'outlet', 'sales', 'updatedAt']);
    const vals = sh.getDataRange().getValues();
    for (let i = vals.length - 1; i >= 1; i--) if (String(vals[i][0]) === month) sh.deleteRow(i + 1);
    const now = new Date().toISOString();
    const rows = Object.keys(q.sales || {}).filter(function (o) { return Number(q.sales[o]) > 0; }).map(function (o) { return [month, o, Number(q.sales[o]), now]; });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
    return { ok: true };
  }

  if (a === 'csv') return { ok: true, csv: C.ledgerCsv(allLedgers(), function (k) { return String(k).indexOf('kasir:') === 0 ? String(k).slice(6) : k; }) };

  return { ok: false, code: 'BAD_REQUEST' };
}

/* ---------- Data member (dibaca langsung dari sheet) ---------- */
function memberSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (MEMBER_SHEET) return ss.getSheetByName(MEMBER_SHEET);
  const all = ss.getSheets();
  for (let i = 0; i < all.length; i++) { const n = all[i].getName(); if (n !== LEDGER_SHEET && n !== REKAP_SHEET) return all[i]; }
  return null;
}
function members() {
  const C = SnapyCore;
  const sh = memberSheet();
  const res = { map: {}, count: 0, byCabang: {}, invalid: 0, dupMerged: 0, sheet: sh ? sh.getName() : '' };
  if (!sh) return res;
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const vals = sh.getDataRange().getValues();
  const norm = function (s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ''); };
  let h = -1, idx = {};
  for (let i = 0; i < Math.min(6, vals.length); i++) {
    const cols = vals[i].map(norm);
    if (cols.indexOf('phone') >= 0 && cols.indexOf('customername') >= 0) {
      h = i;
      const find = function () { for (let k = 0; k < arguments.length; k++) { const j = cols.indexOf(arguments[k]); if (j >= 0) return j; } return -1; };
      idx = { cabang: find('cabang', 'outlet'), name: find('customername'), phone: find('phone'), code: find('customercode'), join: find('joindate') };
      break;
    }
  }
  if (h < 0) return res;
  for (let i = h + 1; i < vals.length; i++) {
    const r = vals[i];
    const phone = C.normPhone(r[idx.phone]);
    const name = String(r[idx.name] || '').trim();
    if (!phone || !name) { if (r.join('').trim()) res.invalid++; continue; }
    let join = '';
    if (idx.join >= 0) { const j = r[idx.join]; join = j instanceof Date ? Utilities.formatDate(j, tz, 'yyyy-MM-dd') : C.parseDate(j); }
    const rec = [name, idx.cabang >= 0 ? String(r[idx.cabang] || '').trim() : '', idx.code >= 0 ? String(r[idx.code] || '').trim() : '', join];
    if (res.map[phone]) { res.dupMerged++; if ((join || '') >= (res.map[phone][3] || '')) res.map[phone] = rec; }
    else res.map[phone] = rec;
  }
  for (const p in res.map) { res.count++; const cb = res.map[p][1] || '(tanpa cabang)'; res.byCabang[cb] = (res.byCabang[cb] || 0) + 1; }
  return res;
}

/* ---------- Ledger ---------- */
function sheetNamed(name, head) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]);
    sh.getRange(1, 1, sh.getMaxRows(), head.length).setNumberFormat('@'); // simpan sebagai teks
    sh.setFrozenRows(1);
  }
  return sh;
}
function ledgerSheet() { return sheetNamed(LEDGER_SHEET, LEDGER_HEAD); }
function rowIn(v) {
  return { txId: String(v[1]), time: String(v[2]), type: String(v[3]), outlet: String(v[4]), kasir: String(v[5]),
    value: Number(v[6]) || 0, points: Number(v[7]) || 0, discount: Number(v[8]) || 0, net: Number(v[9]) || 0,
    status: String(v[10]) || 'ACTIVE', note: String(v[11] || ''), voidedAt: String(v[12] || ''), voidedBy: String(v[13] || '') };
}
function rowOut(phone, r) {
  return [phone, r.txId, r.time, r.type, r.outlet, r.kasir, String(r.value), String(r.points), String(r.discount), String(r.net), r.status, r.note || '', r.voidedAt || '', r.voidedBy || ''];
}
function ledgerFor(phone) {
  const sh = ledgerSheet();
  const last = sh.getLastRow();
  const out = { rows: [], rowNums: [] };
  if (last < 2) return out;
  const vals = sh.getRange(2, 1, last - 1, LEDGER_HEAD.length).getValues();
  for (let i = 0; i < vals.length; i++) if (String(vals[i][0]) === phone) { out.rows.push(rowIn(vals[i])); out.rowNums.push(i + 2); }
  return out;
}
function allLedgers() {
  const sh = ledgerSheet();
  const last = sh.getLastRow();
  const out = {};
  if (last < 2) return out;
  const vals = sh.getRange(2, 1, last - 1, LEDGER_HEAD.length).getValues();
  for (let i = 0; i < vals.length; i++) { const p = String(vals[i][0]); if (!p) continue; (out[p] = out[p] || []).push(rowIn(vals[i])); }
  return out;
}
function salesFor(month) {
  const sh = sheetNamed(REKAP_SHEET, ['month', 'outlet', 'sales', 'updatedAt']);
  const vals = sh.getDataRange().getValues(); const s = {};
  for (let i = 1; i < vals.length; i++) if (String(vals[i][0]) === month) s[String(vals[i][1])] = Number(vals[i][2]) || 0;
  return s;
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
