/**
 * SNAPY Member Checker — Google Apps Script
 * Pasang di Google Sheet data member: Extensions > Apps Script, paste seluruh isi file ini.
 * Script hanya mengembalikan member yang nomornya cocok, tidak pernah seluruh daftar.
 */

const PIN = 'GANTI_PIN_INI';   // <-- ganti dengan PIN kasir (misal 4-6 angka)
const SHEET_NAME = '';         // kosongkan = pakai sheet pertama

function doGet(e) {
  const p = (e && e.parameter) || {};

  // Pengaman: kunci 10 menit kalau ada >20 PIN salah
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('fails') || 0);
  if (fails > 20) return out({ ok: false, code: 'LOCK', error: 'Terlalu banyak PIN salah. Coba lagi 10 menit lagi.' });

  if (String(p.pin || '') !== PIN) {
    cache.put('fails', String(fails + 1), 600);
    return out({ ok: false, code: 'PIN', error: 'PIN salah' });
  }

  if (p.action === 'ping') return out({ ok: true });

  if (p.action === 'find') {
    const q = norm(p.phone);
    if (q.length < 9) return out({ ok: false, error: 'Nomor tidak valid' });

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
    const values = sh.getDataRange().getValues();
    const head = values[0].map(h => String(h).trim().toLowerCase());
    const col = name => head.indexOf(name);
    const iPhone = col('phone');
    if (iPhone < 0) return out({ ok: false, error: 'Kolom "phone" tidak ditemukan di Sheet' });

    const tz = ss.getSpreadsheetTimeZone();
    const get = (row, name) => {
      const i = col(name); if (i < 0) return '';
      const v = row[i];
      if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
      const s = String(v == null ? '' : v).trim();
      return s === '-' ? '' : s;
    };

    const members = [];
    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      if (norm(row[iPhone]) !== q) continue;
      members.push({
        o: get(row, 'outlet'),
        k: get(row, 'customercode'),
        n: get(row, 'customername'),
        p: norm(row[iPhone]),
        a: [get(row, 'address1'), get(row, 'address2'), get(row, 'address3')],
        j: get(row, 'joindate')
      });
      if (members.length >= 5) break;
    }
    return out({ ok: true, members: members });
  }

  return out({ ok: false, error: 'Aksi tidak dikenal' });
}

function norm(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.indexOf('62') === 0) d = d.slice(2);
  d = d.replace(/^0+/, '');
  return d ? '0' + d : '';
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
