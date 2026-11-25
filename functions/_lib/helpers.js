const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

export function nowIso() {
  const d = new Date(Date.now() + JAKARTA_OFFSET_MS);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function todayDate() {
  const d = new Date(Date.now() + JAKARTA_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

export function addDaysDate(days) {
  const d = new Date(Date.now() + JAKARTA_OFFSET_MS + days * 86400000);
  return d.toISOString().slice(0, 10);
}

export function currentYearJakarta() {
  const d = new Date(Date.now() + JAKARTA_OFFSET_MS);
  return d.getUTCFullYear();
}

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      ...extraHeaders,
    },
  });
}

export function jsonError(message, status = 400, extra = {}) {
  return jsonResponse({ ok: false, error: message, ...extra }, status);
}

export async function getJsonBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return {};
  try {
    const text = await request.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeWa(wa) {
  let digits = String(wa || '').trim().replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) {
    digits = '62' + digits.slice(1);
  } else if (digits.startsWith('8')) {
    digits = '62' + digits;
  }
  return digits;
}

export function tingkatPrefix(tingkat) {
  if (tingkat === 'Mula') return 'MU';
  if (tingkat === 'Madya') return 'MA';
  if (tingkat === 'Wira') return 'WI';
  throw new Error('Tingkat tidak valid');
}

export async function hashPassword(password) {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const saltHex = Array.from(saltBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  const hashHex = Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2$100000$${saltHex}$${hashHex}`;
}

export async function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  const saltHex = parts[2];
  const expectedHex = parts[3];
  const saltBytes = new Uint8Array(saltHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    key,
    256
  );
  const actualHex = Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
  if (actualHex.length !== expectedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < actualHex.length; i++) {
    diff |= actualHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return diff === 0;
}

export async function checkPublicRateLimit(db, request, maxPerMinute = 240) {
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '127.0.0.1';
  const window = Math.floor(Date.now() / 60000);

  await db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(window - 2).run();
  const row = await db.prepare('SELECT count FROM rate_limits WHERE ip = ? AND window_start = ?').bind(ip, window).first();
  const count = row ? Number(row.count) : 0;

  if (count >= maxPerMinute) {
    return jsonError('Terlalu banyak permintaan. Silakan tunggu sebentar.', 429);
  }

  await db.prepare(
    'INSERT INTO rate_limits (ip, window_start, count) VALUES (?, ?, 1) ON CONFLICT(ip, window_start) DO UPDATE SET count = count + 1'
  ).bind(ip, window).run();

  return null;
}

export async function writeLog(db, actor, jenisAktivitas, detail, rujukanData = '', kontingenKode = '', posNama = '') {
  await db.prepare(`
    INSERT INTO log (waktu, pelaku_id, pelaku_nama, pelaku_peran, jenis_aktivitas, rujukan_data, kontingen_kode, pos_nama, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    nowIso(),
    actor ? actor.id : null,
    actor ? actor.nama : 'Sistem',
    actor ? actor.peran : 'sistem',
    jenisAktivitas,
    rujukanData,
    kontingenKode,
    posNama,
    detail
  ).run();
}

export async function getActiveKegiatan(db) {
  let row = await db.prepare('SELECT * FROM kegiatan WHERE is_active = 1 ORDER BY tahun DESC LIMIT 1').first();
  if (!row) {
    row = await db.prepare('SELECT * FROM kegiatan ORDER BY tahun DESC LIMIT 1').first();
  }
  if (!row) return null;
  let tingkat = [];
  try {
    tingkat = JSON.parse(row.tingkat_aktif) || [];
  } catch {
    tingkat = [];
  }
  return {
    ...row,
    id: Number(row.id),
    tahun: Number(row.tahun),
    is_active: Boolean(row.is_active),
    tingkat_aktif: tingkat,
    is_locked_by_date: todayDate() >= row.hari_kunci,
  };
}

export function isKontingenLocked(kegiatan, kontingen) {
  return (kontingen?.status || 'terbuka') === 'terkunci' || todayDate() >= (kegiatan?.hari_kunci || '9999-12-31');
}

export function generateTempPassword(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[arr[i] % chars.length];
  }
  return out;
}

export async function recalculateNilaiAkhirPos(db, kontingenId, posId) {
  const posRow = await db.prepare('SELECT * FROM pos WHERE id = ?').bind(posId).first();
  if (!posRow) throw new Error('Pos tidak ditemukan');

  const kontingenRow = await db.prepare('SELECT * FROM kontingen WHERE id = ?').bind(kontingenId).first();
  if (!kontingenRow) throw new Error('Kontingen tidak ditemukan');

  const { results: sessions } = await db.prepare(`
    SELECT s.*
    FROM sesi_penilaian s
    INNER JOIN (
      SELECT juri_id, MAX(id) AS max_id
      FROM sesi_penilaian
      WHERE kontingen_id = ? AND pos_id = ? AND status = 'selesai'
      GROUP BY juri_id
    ) latest ON latest.max_id = s.id
    ORDER BY s.juri_id ASC
  `).bind(kontingenId, posId).all();

  if (!sessions || sessions.length === 0) {
    await db.prepare('DELETE FROM nilai_akhir_pos WHERE kontingen_id = ? AND pos_id = ?').bind(kontingenId, posId).run();
    return { nilai_akhir: 0, total_timer: 0, bidak: 0, has_revisi: 0 };
  }

  const judgeTotals = [];
  const timers = [];
  const bidaks = [];
  const sessionIds = [];

  for (const sesi of sessions) {
    sessionIds.push(Number(sesi.id));
    const sumRow = await db.prepare('SELECT COALESCE(SUM(nilai), 0) AS total FROM nilai_juri WHERE sesi_id = ?').bind(sesi.id).first();
    judgeTotals.push(Number(sumRow ? sumRow.total : 0));
    timers.push(Number(sesi.timer_detik));
    bidaks.push(Number(sesi.bidak));
  }

  const sumTotals = judgeTotals.reduce((a, b) => a + b, 0);
  const nilaiAkhir = posRow.cara_gabung === 'jumlah'
    ? Math.round(sumTotals * 100) / 100
    : Math.round((sumTotals / Math.max(1, judgeTotals.length)) * 100) / 100;

  const totalTimer = Number(posRow.pakai_timer)
    ? Math.round(timers.reduce((a, b) => a + b, 0) / Math.max(1, timers.length))
    : 0;
  const bidak = Number(posRow.pakai_bidak)
    ? Math.round((bidaks.reduce((a, b) => a + b, 0) / Math.max(1, bidaks.length)) * 100) / 100
    : 0;

  const placeholders = sessionIds.map(() => '?').join(',');
  const revRow = await db.prepare(`SELECT COUNT(*) AS cnt FROM koreksi WHERE sesi_id IN (${placeholders}) AND status = 'disetujui'`).bind(...sessionIds).first();
  const hasRevisi = revRow && Number(revRow.cnt) > 0 ? 1 : 0;

  await db.prepare(`
    INSERT INTO nilai_akhir_pos (kegiatan_id, kontingen_id, pos_id, nilai_akhir, total_timer, bidak, has_revisi, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kontingen_id, pos_id) DO UPDATE SET
      nilai_akhir = excluded.nilai_akhir,
      total_timer = excluded.total_timer,
      bidak = excluded.bidak,
      has_revisi = excluded.has_revisi,
      updated_at = excluded.updated_at
  `).bind(
    Number(kontingenRow.kegiatan_id),
    kontingenId,
    posId,
    nilaiAkhir,
    totalTimer,
    bidak,
    hasRevisi,
    nowIso()
  ).run();

  return { nilai_akhir: nilaiAkhir, total_timer: totalTimer, bidak, has_revisi: hasRevisi };
}

export async function getReceiptPayload(db, kegiatanId, kontingenKode, posId) {
  const kegiatan = await db.prepare('SELECT * FROM kegiatan WHERE id = ?').bind(kegiatanId).first();
  const kontingen = await db.prepare(`
    SELECT k.*, s.nama AS sekolah_nama
    FROM kontingen k
    JOIN sekolah s ON s.id = k.sekolah_id
    WHERE k.kegiatan_id = ? AND k.kode = ?
  `).bind(kegiatanId, kontingenKode).first();
  const pos = await db.prepare('SELECT * FROM pos WHERE id = ? AND kegiatan_id = ?').bind(posId, kegiatanId).first();

  if (!kegiatan || !kontingen || !pos) return null;

  const { results: rubriks } = await db.prepare('SELECT * FROM rubrik WHERE pos_id = ? ORDER BY urutan ASC, id ASC').bind(posId).all();
  const { results: sessions } = await db.prepare(`
    SELECT s.*, a.nama AS juri_nama
    FROM sesi_penilaian s
    JOIN akun a ON a.id = s.juri_id
    INNER JOIN (
      SELECT juri_id, MAX(id) AS max_id
      FROM sesi_penilaian
      WHERE kontingen_id = ? AND pos_id = ? AND status = 'selesai'
      GROUP BY juri_id
    ) latest ON latest.max_id = s.id
    ORDER BY s.id ASC
  `).bind(Number(kontingen.id), posId).all();

  const nilaiAkhir = await db.prepare('SELECT * FROM nilai_akhir_pos WHERE kontingen_id = ? AND pos_id = ?').bind(Number(kontingen.id), posId).first();

  const juriBreakdown = [];
  const hasRevisi = Boolean(nilaiAkhir?.has_revisi);

  for (let idx = 0; idx < (sessions || []).length; idx++) {
    const sesi = sessions[idx];
    const { results: items } = await db.prepare(`
      SELECT nj.rubrik_id, nj.nilai, r.nama AS rubrik_nama, r.komponen, r.nilai_maksimal, r.urutan
      FROM nilai_juri nj
      JOIN rubrik r ON r.id = nj.rubrik_id
      WHERE nj.sesi_id = ?
      ORDER BY r.urutan ASC, r.id ASC
    `).bind(sesi.id).all();

    let totalJuri = 0;
    const komponenSubtotals = {};
    for (const item of items || []) {
      const val = Number(item.nilai);
      totalJuri += val;
      const komp = item.komponen || 'Umum';
      komponenSubtotals[komp] = (komponenSubtotals[komp] || 0) + val;
    }

    juriBreakdown.push({
      sesi_id: Number(sesi.id),
      juri_urutan: idx + 1,
      juri_nama: sesi.juri_nama,
      waktu_selesai: sesi.waktu_selesai,
      timer_detik: Number(sesi.timer_detik),
      bidak: Number(sesi.bidak),
      reprint_count: Number(sesi.reprint_count),
      total_juri: Math.round(totalJuri * 100) / 100,
      komponen_subtotals: komponenSubtotals,
      rubrik_nilai: items || [],
    });
  }

  return {
    kegiatan: {
      id: Number(kegiatan.id),
      tahun: Number(kegiatan.tahun),
      nama: kegiatan.nama,
    },
    kontingen: {
      id: Number(kontingen.id),
      kode: kontingen.kode,
      tingkat: kontingen.tingkat,
      jenis: kontingen.jenis,
      sekolah_nama: kontingen.sekolah_nama,
    },
    pos: {
      id: Number(pos.id),
      nama: pos.nama,
      jumlah_juri: Number(pos.jumlah_juri),
      cara_gabung: pos.cara_gabung,
      pakai_timer: Boolean(pos.pakai_timer),
      pakai_bidak: Boolean(pos.pakai_bidak),
    },
    rubriks: rubriks || [],
    juri_breakdown: juriBreakdown,
    nilai_akhir: nilaiAkhir ? Number(nilaiAkhir.nilai_akhir) : 0,
    total_timer: nilaiAkhir ? Number(nilaiAkhir.total_timer) : 0,
    bidak: nilaiAkhir ? Number(nilaiAkhir.bidak) : 0,
    has_revisi: hasRevisi,
    qr_url: `publik.html?kegiatan=${Number(kegiatan.id)}&kontingen=${encodeURIComponent(kontingen.kode)}&pos=${Number(pos.id)}`,
  };
}
