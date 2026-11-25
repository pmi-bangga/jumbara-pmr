import {
  nowIso,
  jsonResponse,
  jsonError,
  writeLog,
  getActiveKegiatan,
  recalculateNilaiAkhirPos,
  getReceiptPayload,
} from './helpers.js';

async function assertJudgeAssigned(db, posId, juriId) {
  const pos = await db.prepare(`
    SELECT p.*
    FROM pos p
    JOIN penugasan_juri pj ON pj.pos_id = p.id
    WHERE p.id = ? AND pj.juri_id = ?
  `).bind(posId, juriId).first();
  return pos || null;
}

export async function handleJuriAction(db, user, action, body, url) {
  const kegiatan = await getActiveKegiatan(db);
  if (!kegiatan) {
    return jsonError('Belum ada kegiatan aktif.', 400);
  }

  if (action === 'juri_bootstrap') {
    const { results: posRows } = await db.prepare(`
      SELECT p.*
      FROM pos p
      JOIN penugasan_juri pj ON pj.pos_id = p.id
      WHERE p.kegiatan_id = ? AND pj.juri_id = ?
      ORDER BY p.id ASC
    `).bind(kegiatan.id, user.id).all();

    const posList = [];
    for (const p of posRows || []) {
      const { results: rubriks } = await db.prepare('SELECT * FROM rubrik WHERE pos_id = ? ORDER BY urutan ASC, id ASC').bind(p.id).all();
      posList.push({
        ...p,
        id: Number(p.id),
        jumlah_juri: Number(p.jumlah_juri),
        pakai_timer: Boolean(p.pakai_timer),
        pakai_bidak: Boolean(p.pakai_bidak),
        rubriks: rubriks || [],
      });
    }

    const { results: pesertaCache } = await db.prepare(`
      SELECT p.id, p.kode_peserta, p.nama, k.id AS kontingen_id, k.kode AS kontingen_kode, k.tingkat, k.jenis, s.nama AS sekolah_nama
      FROM peserta p
      JOIN kontingen k ON k.id = p.kontingen_id
      JOIN sekolah s ON s.id = k.sekolah_id
      WHERE p.kegiatan_id = ?
      ORDER BY p.kode_peserta ASC
    `).bind(kegiatan.id).all();

    const { results: history } = await db.prepare(`
      SELECT sp.*, k.kode AS kontingen_kode, k.tingkat, s.nama AS sekolah_nama, p.nama AS pos_nama,
             COALESCE((SELECT SUM(nj.nilai) FROM nilai_juri nj WHERE nj.sesi_id = sp.id), 0) AS total_juri,
             COALESCE(nap.nilai_akhir, 0) AS nilai_akhir_pos,
             COALESCE(nap.has_revisi, 0) AS has_revisi,
             (SELECT status FROM koreksi kr WHERE kr.sesi_id = sp.id ORDER BY kr.id DESC LIMIT 1) AS koreksi_terakhir_status
      FROM sesi_penilaian sp
      JOIN kontingen k ON k.id = sp.kontingen_id
      JOIN sekolah s ON s.id = k.sekolah_id
      JOIN pos p ON p.id = sp.pos_id
      LEFT JOIN nilai_akhir_pos nap ON nap.kontingen_id = sp.kontingen_id AND nap.pos_id = sp.pos_id
      WHERE sp.kegiatan_id = ? AND sp.juri_id = ? AND sp.status = 'selesai'
      ORDER BY sp.waktu_selesai DESC, sp.id DESC
      LIMIT 80
    `).bind(kegiatan.id, user.id).all();

    return jsonResponse({
      ok: true,
      kegiatan,
      pos_list: posList,
      peserta_cache: pesertaCache || [],
      history: history || [],
    });
  }

  if (action === 'juri_lookup_peserta') {
    const posId = Number(url.searchParams.get('pos_id') || body.pos_id || 0);
    const kode = String(url.searchParams.get('kode') || body.kode || '').trim().toUpperCase();
    const pos = await assertJudgeAssigned(db, posId, user.id);
    if (!pos) return jsonError('Anda tidak ditugaskan pada pos ini.', 403);

    if (!kode) {
      return jsonError('Kode peserta wajib diisi atau dipindai.', 400);
    }

    const row = await db.prepare(`
      SELECT p.id, p.kode_peserta, p.nama, k.id AS kontingen_id, k.kode AS kontingen_kode, k.tingkat, k.jenis, s.nama AS sekolah_nama
      FROM peserta p
      JOIN kontingen k ON k.id = p.kontingen_id
      JOIN sekolah s ON s.id = k.sekolah_id
      WHERE p.kegiatan_id = ? AND UPPER(p.kode_peserta) = ?
      LIMIT 1
    `).bind(kegiatan.id, kode).first();

    if (!row) {
      return jsonError(`Kode peserta "${kode}" tidak terdaftar pada kegiatan ini.`, 404);
    }

    return jsonResponse({ ok: true, peserta: row });
  }

  if (action === 'juri_session_start') {
    const posId = Number(body.pos_id || 0);
    const kontingenId = Number(body.kontingen_id || 0);
    const uuid = String(body.client_session_uuid || '').trim();

    const pos = await assertJudgeAssigned(db, posId, user.id);
    if (!pos) return jsonError('Anda tidak ditugaskan pada pos ini.', 403);
    if (!uuid || kontingenId <= 0) {
      return jsonError('UUID sesi dan kontingen wajib diisi.', 400);
    }

    const kontingen = await db.prepare('SELECT id, kode FROM kontingen WHERE id = ? AND kegiatan_id = ?').bind(kontingenId, kegiatan.id).first();
    if (!kontingen) {
      return jsonError('Kontingen tidak ditemukan.', 404);
    }

    const existing = await db.prepare('SELECT id, status FROM sesi_penilaian WHERE client_session_uuid = ?').bind(uuid).first();
    if (existing) {
      return jsonResponse({ ok: true, sesi_id: Number(existing.id), status: existing.status });
    }

    const res = await db.prepare(`
      INSERT INTO sesi_penilaian (client_session_uuid, kegiatan_id, kontingen_id, pos_id, juri_id, status, timer_detik, bidak, waktu_mulai)
      VALUES (?, ?, ?, ?, ?, 'berjalan', 0, 0, ?)
    `).bind(uuid, kegiatan.id, kontingenId, posId, user.id, nowIso()).run();

    return jsonResponse({ ok: true, sesi_id: Number(res.meta.last_row_id), status: 'berjalan' });
  }

  if (action === 'juri_session_cancel') {
    const uuid = String(body.client_session_uuid || '').trim();
    if (uuid) {
      await db.prepare(`
        UPDATE sesi_penilaian SET status = 'dibatalkan', waktu_selesai = ?
        WHERE client_session_uuid = ? AND juri_id = ? AND status IN ('berjalan', 'draf')
      `).bind(nowIso(), uuid, user.id).run();
    }
    return jsonResponse({ ok: true });
  }

  if (action === 'juri_session_submit') {
    const uuid = String(body.client_session_uuid || '').trim();
    const posId = Number(body.pos_id || 0);
    const kontingenId = Number(body.kontingen_id || 0);
    const timerDetik = Math.max(0, Math.floor(Number(body.timer_detik || 0)));
    const bidak = Number(body.bidak || 0);
    const attendees = body.peserta_roles;
    const scores = body.scores;

    const pos = await assertJudgeAssigned(db, posId, user.id);
    if (!pos) return jsonError('Anda tidak ditugaskan pada pos ini.', 403);

    if (!uuid || kontingenId <= 0 || !Array.isArray(attendees) || attendees.length === 0 || !Array.isArray(scores)) {
      return jsonError('Data sesi penilaian belum lengkap (minimal 1 peserta hadir dan nilai rubrik).', 400);
    }

    const kontingen = await db.prepare('SELECT id, kode FROM kontingen WHERE id = ? AND kegiatan_id = ?').bind(kontingenId, kegiatan.id).first();
    if (!kontingen) {
      return jsonError('Kontingen tidak valid.', 400);
    }

    const existingSesi = await db.prepare('SELECT * FROM sesi_penilaian WHERE client_session_uuid = ?').bind(uuid).first();
    if (existingSesi && existingSesi.status === 'selesai') {
      const receipt = await getReceiptPayload(db, Number(kegiatan.id), kontingen.kode, posId);
      return jsonResponse({ ok: true, deduplicated: true, sesi_id: Number(existingSesi.id), receipt });
    }

    const { results: rubrikRows } = await db.prepare('SELECT * FROM rubrik WHERE pos_id = ?').bind(posId).all();
    const rubrikMap = {};
    for (const r of rubrikRows || []) {
      rubrikMap[Number(r.id)] = r;
    }
    if (Object.keys(rubrikMap).length === 0) {
      return jsonError('Pos belum memiliki rubrik penilaian.', 400);
    }

    const cleanScores = {};
    for (const s of scores) {
      const rubId = Number(s.rubrik_id || 0);
      const val = Number(s.nilai || 0);
      const uidUnik = String(s.uid_unik || `${uuid}-r${rubId}`).trim();
      if (!rubrikMap[rubId]) {
        return jsonError('Rubrik tidak sesuai dengan pos.', 400);
      }
      const maxVal = Number(rubrikMap[rubId].nilai_maksimal);
      if (val < 0 || val > maxVal) {
        return jsonError(`Nilai rubrik ${rubrikMap[rubId].nama} harus antara 0 dan ${maxVal}.`, 400);
      }
      cleanScores[rubId] = { uid_unik: uidUnik, nilai: val };
    }

    const cleanAttendees = {};
    for (const a of attendees) {
      const pid = Number(a.peserta_id || 0);
      const peran = String(a.peran_di_pos || 'Anggota').trim() || 'Anggota';
      if (pid <= 0) continue;
      const pCheck = await db.prepare('SELECT id FROM peserta WHERE id = ? AND kontingen_id = ?').bind(pid, kontingenId).first();
      if (!pCheck) {
        return jsonError('Peserta tidak termasuk dalam kontingen sesi ini.', 400);
      }
      cleanAttendees[pid] = peran;
    }
    if (Object.keys(cleanAttendees).length === 0) {
      return jsonError('Minimal satu peserta harus hadir dalam sesi.', 400);
    }

    const now = nowIso();
    let sesiId;
    if (existingSesi) {
      sesiId = Number(existingSesi.id);
      await db.prepare(
        "UPDATE sesi_penilaian SET status = 'selesai', timer_detik = ?, bidak = ?, waktu_selesai = ? WHERE id = ?"
      ).bind(timerDetik, bidak, now, sesiId).run();
    } else {
      const sRes = await db.prepare(
        "INSERT INTO sesi_penilaian (client_session_uuid, kegiatan_id, kontingen_id, pos_id, juri_id, status, timer_detik, bidak, waktu_mulai, waktu_selesai) VALUES (?, ?, ?, ?, ?, 'selesai', ?, ?, ?, ?)"
      ).bind(uuid, kegiatan.id, kontingenId, posId, user.id, timerDetik, bidak, now, now).run();
      sesiId = Number(sRes.meta.last_row_id);
    }

    const batchStmts = [];
    for (const [pidStr, peran] of Object.entries(cleanAttendees)) {
      batchStmts.push(
        db.prepare('INSERT INTO kehadiran (sesi_id, peserta_id, peran_di_pos) VALUES (?, ?, ?) ON CONFLICT(sesi_id, peserta_id) DO UPDATE SET peran_di_pos = excluded.peran_di_pos')
          .bind(sesiId, Number(pidStr), peran)
      );
    }
    for (const [rubIdStr, sc] of Object.entries(cleanScores)) {
      batchStmts.push(
        db.prepare('INSERT OR IGNORE INTO nilai_juri (uid_unik, sesi_id, juri_id, rubrik_id, nilai, timer, bidak, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(sc.uid_unik, sesiId, user.id, Number(rubIdStr), sc.nilai, timerDetik, bidak, now)
      );
    }
    if (batchStmts.length > 0) {
      await db.batch(batchStmts);
    }

    const recalc = await recalculateNilaiAkhirPos(db, kontingenId, posId);
    await writeLog(
      db,
      user,
      'penilaian_selesai',
      `Penilaian selesai untuk ${kontingen.kode} di ${pos.nama} (nilai akhir pos: ${recalc.nilai_akhir}).`,
      `sesi:${sesiId}`,
      kontingen.kode,
      pos.nama
    );

    const receipt = await getReceiptPayload(db, Number(kegiatan.id), kontingen.kode, posId);
    return jsonResponse({ ok: true, deduplicated: false, sesi_id: sesiId, receipt });
  }

  if (action === 'juri_get_receipt' || action === 'juri_reprint_receipt') {
    const sesiId = Number(url.searchParams.get('sesi_id') || body.sesi_id || 0);
    const sesi = await db.prepare(`
      SELECT sp.*, k.kode AS kontingen_kode, p.nama AS pos_nama
      FROM sesi_penilaian sp
      JOIN kontingen k ON k.id = sp.kontingen_id
      JOIN pos p ON p.id = sp.pos_id
      WHERE sp.id = ? AND sp.juri_id = ? AND sp.status = 'selesai'
    `).bind(sesiId, user.id).first();

    if (!sesi) {
      return jsonError('Sesi tidak ditemukan.', 404);
    }

    if (action === 'juri_reprint_receipt') {
      await db.prepare('UPDATE sesi_penilaian SET reprint_count = reprint_count + 1 WHERE id = ?').bind(sesiId).run();
      const receipt = await getReceiptPayload(db, Number(sesi.kegiatan_id), sesi.kontingen_kode, Number(sesi.pos_id));
      const label = receipt && receipt.has_revisi ? 'REVISI' : 'DUPLIKAT';
      await writeLog(db, user, 'cetak_ulang', `Cetak ulang struk (${label}) ${sesi.kontingen_kode} - ${sesi.pos_nama}.`, `sesi:${sesiId}`, sesi.kontingen_kode, sesi.pos_nama);
      return jsonResponse({ ok: true, receipt, reprint_badge: label });
    }

    const receipt = await getReceiptPayload(db, Number(sesi.kegiatan_id), sesi.kontingen_kode, Number(sesi.pos_id));
    return jsonResponse({ ok: true, receipt });
  }

  if (action === 'juri_get_session_detail') {
    const sesiId = Number(url.searchParams.get('sesi_id') || 0);
    const sesi = await db.prepare(`
      SELECT sp.*, k.kode AS kontingen_kode, p.nama AS pos_nama, p.pakai_timer, p.pakai_bidak
      FROM sesi_penilaian sp
      JOIN kontingen k ON k.id = sp.kontingen_id
      JOIN pos p ON p.id = sp.pos_id
      WHERE sp.id = ? AND sp.juri_id = ?
    `).bind(sesiId, user.id).first();

    if (!sesi) {
      return jsonError('Sesi tidak ditemukan.', 404);
    }

    const { results: scores } = await db.prepare(`
      SELECT nj.rubrik_id, nj.nilai, r.nama, r.komponen, r.nilai_maksimal
      FROM nilai_juri nj
      JOIN rubrik r ON r.id = nj.rubrik_id
      WHERE nj.sesi_id = ?
      ORDER BY r.urutan ASC, r.id ASC
    `).bind(sesiId).all();

    const { results: koreksi } = await db.prepare('SELECT * FROM koreksi WHERE sesi_id = ? ORDER BY id DESC').bind(sesiId).all();

    return jsonResponse({ ok: true, sesi, scores: scores || [], koreksi: koreksi || [] });
  }

  if (action === 'juri_request_correction') {
    const sesiId = Number(body.sesi_id || 0);
    const alasan = String(body.alasan || '').trim();
    const newScores = body.scores;
    const newTimer = Math.max(0, Math.floor(Number(body.timer_detik || 0)));
    const newBidak = Number(body.bidak || 0);

    if (sesiId <= 0 || !alasan || !Array.isArray(newScores)) {
      return jsonError('Alasan koreksi dan nilai baru wajib diisi.', 400);
    }

    const sesi = await db.prepare(`
      SELECT sp.*, k.kode AS kontingen_kode, p.nama AS pos_nama
      FROM sesi_penilaian sp
      JOIN kontingen k ON k.id = sp.kontingen_id
      JOIN pos p ON p.id = sp.pos_id
      WHERE sp.id = ? AND sp.juri_id = ? AND sp.status = 'selesai'
    `).bind(sesiId, user.id).first();

    if (!sesi) {
      return jsonError('Sesi penilaian tidak ditemukan.', 404);
    }

    const { results: oldRows } = await db.prepare(`
      SELECT nj.rubrik_id, nj.nilai, r.nama, r.nilai_maksimal
      FROM nilai_juri nj
      JOIN rubrik r ON r.id = nj.rubrik_id
      WHERE nj.sesi_id = ?
      ORDER BY r.urutan ASC, r.id ASC
    `).bind(sesiId).all();

    const oldMap = {};
    let oldTotal = 0;
    for (const row of oldRows || []) {
      oldMap[Number(row.rubrik_id)] = {
        rubrik_id: Number(row.rubrik_id),
        nama: row.nama,
        nilai: Number(row.nilai),
        nilai_maksimal: Number(row.nilai_maksimal),
      };
      oldTotal += Number(row.nilai);
    }

    const newItems = [];
    let newTotal = 0;
    for (const sc of newScores) {
      const rid = Number(sc.rubrik_id || 0);
      const val = Number(sc.nilai || 0);
      if (!oldMap[rid]) {
        return jsonError('Rubrik tidak valid.', 400);
      }
      if (val < 0 || val > oldMap[rid].nilai_maksimal) {
        return jsonError(`Nilai ${oldMap[rid].nama} melebihi batas maksimal.`, 400);
      }
      newItems.push({ rubrik_id: rid, nama: oldMap[rid].nama, nilai: val });
      newTotal += val;
    }

    const detailLama = JSON.stringify({
      scores: Object.values(oldMap),
      timer_detik: Number(sesi.timer_detik),
      bidak: Number(sesi.bidak),
      total: Math.round(oldTotal * 100) / 100,
    });

    const detailBaru = JSON.stringify({
      scores: newItems,
      timer_detik: newTimer,
      bidak: newBidak,
      total: Math.round(newTotal * 100) / 100,
    });

    const res = await db.prepare(`
      INSERT INTO koreksi (sesi_id, detail_lama, detail_baru, nilai_lama, nilai_baru, alasan, juri_pengaju_id, status, waktu_pengajuan)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'diajukan', ?)
    `).bind(
      sesiId,
      detailLama,
      detailBaru,
      Math.round(oldTotal * 100) / 100,
      Math.round(newTotal * 100) / 100,
      alasan,
      user.id,
      nowIso()
    ).run();
    const kid = Number(res.meta.last_row_id);

    await writeLog(
      db,
      user,
      'koreksi_diajukan',
      `Pengajuan koreksi ${sesi.kontingen_kode} di ${sesi.pos_nama} (${oldTotal} -> ${newTotal}). Alasan: ${alasan}`,
      `koreksi:${kid}`,
      sesi.kontingen_kode,
      sesi.pos_nama
    );

    return jsonResponse({ ok: true, id: kid });
  }

  return jsonError('Aksi juri tidak dikenal.', 404);
}
