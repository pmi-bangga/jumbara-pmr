import {
  nowIso,
  todayDate,
  jsonResponse,
  jsonError,
  tingkatPrefix,
  writeLog,
  getActiveKegiatan,
  isKontingenLocked,
} from './helpers.js';

export async function handlePembinaAction(db, user, action, body) {
  const kegiatan = await getActiveKegiatan(db);

  if (action === 'pembina_dashboard') {
    if (!kegiatan) {
      return jsonResponse({ ok: true, kegiatan: null, sekolah: [], kontingen: null, peserta: [] });
    }
    const { results: schools } = await db.prepare('SELECT id, nama, npsn, jenjang, kecamatan, alamat FROM sekolah ORDER BY kecamatan ASC, nama ASC').all();

    const kontingen = await db.prepare(`
      SELECT k.*, s.nama AS sekolah_nama
      FROM kontingen k
      JOIN sekolah s ON s.id = k.sekolah_id
      WHERE k.kegiatan_id = ? AND k.pembina_id = ?
      LIMIT 1
    `).bind(kegiatan.id, user.id).first();

    let peserta = [];
    if (kontingen) {
      kontingen.is_locked = isKontingenLocked(kegiatan, kontingen);
      const { results } = await db.prepare('SELECT * FROM peserta WHERE kontingen_id = ? ORDER BY kode_peserta ASC').bind(kontingen.id).all();
      peserta = results || [];
    }

    return jsonResponse({
      ok: true,
      kegiatan,
      sekolah: schools || [],
      kontingen: kontingen || null,
      peserta,
    });
  }

  if (!kegiatan) {
    return jsonError('Belum ada kegiatan aktif.', 400);
  }

  if (action === 'pembina_create_kontingen') {
    const sekolahId = Number(body.sekolah_id || 0);
    const tingkat = String(body.tingkat || '').trim();
    const jenis = String(body.jenis || '').trim();

    if (sekolahId <= 0 || !['Mula', 'Madya', 'Wira'].includes(tingkat) || !['putra', 'putri', 'gabungan'].includes(jenis)) {
      return jsonError('Sekolah, tingkat, dan jenis kontingen wajib dipilih.', 400);
    }
    if (!kegiatan.tingkat_aktif.includes(tingkat)) {
      return jsonError(`Tingkat ${tingkat} tidak aktif pada kegiatan tahun ini.`, 400);
    }
    if (todayDate() >= kegiatan.hari_kunci) {
      return jsonError('Pendaftaran sudah dikunci mulai hari kunci.', 403);
    }

    const existsSelf = await db.prepare('SELECT id FROM kontingen WHERE kegiatan_id = ? AND pembina_id = ?').bind(kegiatan.id, user.id).first();
    if (existsSelf) {
      return jsonError('Satu pembina hanya mengelola satu kontingen per kegiatan.', 400);
    }

    const school = await db.prepare('SELECT id, nama FROM sekolah WHERE id = ?').bind(sekolahId).first();
    if (!school) {
      return jsonError('Sekolah tidak ditemukan dalam daftar admin.', 400);
    }

    const { results: schKontingens } = await db.prepare('SELECT jenis FROM kontingen WHERE kegiatan_id = ? AND sekolah_id = ?').bind(kegiatan.id, sekolahId).all();
    const existingJenis = (schKontingens || []).map((r) => r.jenis);
    if (existingJenis.includes('gabungan') || (jenis === 'gabungan' && existingJenis.length > 0) || existingJenis.includes(jenis)) {
      return jsonError('Sekolah ini sudah memiliki kontingen untuk jenis tersebut (maksimal 1 gabungan, atau 1 putra dan 1 putri terpisah).', 400);
    }

    const prefix = tingkatPrefix(tingkat);
    const { results: kCodes } = await db.prepare('SELECT kode FROM kontingen WHERE kegiatan_id = ? AND kode LIKE ?').bind(kegiatan.id, `${prefix}%`).all();
    let maxNum = 0;
    for (const row of kCodes || []) {
      const num = parseInt(String(row.kode).slice(2), 10) || 0;
      if (num > maxNum) maxNum = num;
    }
    const kode = `${prefix}${String(maxNum + 1).padStart(3, '0')}`;

    const res = await db.prepare(`
      INSERT INTO kontingen (kegiatan_id, sekolah_id, tingkat, jenis, kode, pembina_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'terbuka', ?)
    `).bind(kegiatan.id, sekolahId, tingkat, jenis, kode, user.id, nowIso()).run();
    const kid = Number(res.meta.last_row_id);

    await writeLog(db, user, 'pendaftaran_kontingen', `Kontingen ${kode} (${school.nama} - ${tingkat} ${jenis}) didaftarkan.`, `kontingen:${kid}`, kode);

    return jsonResponse({ ok: true, kode, id: kid });
  }

  const kontingen = await db.prepare('SELECT * FROM kontingen WHERE kegiatan_id = ? AND pembina_id = ? LIMIT 1').bind(kegiatan.id, user.id).first();
  if (!kontingen) {
    return jsonError('Kontingen Anda belum dibuat.', 400);
  }

  if (isKontingenLocked(kegiatan, kontingen)) {
    return jsonError('Data kontingen sudah dikunci mulai hari kunci. Hubungi admin jika ada perubahan mendesak.', 403);
  }

  if (action === 'pembina_add_peserta') {
    const nama = String(body.nama || '').trim();
    const tglLahir = String(body.tanggal_lahir || '').trim();
    const kontak = String(body.kontak || '').trim();

    if (!nama || !/^\d{4}-\d{2}-\d{2}$/.test(tglLahir)) {
      return jsonError('Nama dan tanggal lahir (YYYY-MM-DD) peserta wajib diisi.', 400);
    }

    const dup = await db.prepare(`
      SELECT p.kode_peserta, k.kode
      FROM peserta p JOIN kontingen k ON k.id = p.kontingen_id
      WHERE p.kegiatan_id = ? AND LOWER(TRIM(p.nama)) = LOWER(?) AND p.tanggal_lahir = ?
    `).bind(kegiatan.id, nama, tglLahir).first();
    if (dup) {
      return jsonError(`Peserta dengan nama & tanggal lahir tersebut sudah terdaftar di kontingen ${dup.kode} (${dup.kode_peserta}).`, 400);
    }

    const { results: pCodes } = await db.prepare('SELECT kode_peserta FROM peserta WHERE kontingen_id = ?').bind(kontingen.id).all();
    let maxSeq = 0;
    for (const row of pCodes || []) {
      const seq = parseInt(String(row.kode_peserta).slice(5, 7), 10) || 0;
      if (seq > maxSeq) maxSeq = seq;
    }
    const nextSeq = maxSeq + 1;
    if (nextSeq > 99) {
      return jsonError('Maksimal 99 peserta per kontingen.', 400);
    }
    const kodePeserta = `${kontingen.kode}${String(nextSeq).padStart(2, '0')}`;

    const res = await db.prepare(`
      INSERT INTO peserta (kontingen_id, kegiatan_id, kode_peserta, nama, tanggal_lahir, kontak, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(kontingen.id, kegiatan.id, kodePeserta, nama, tglLahir, kontak, nowIso()).run();
    const pid = Number(res.meta.last_row_id);

    await writeLog(db, user, 'tambah_peserta', `Peserta ${kodePeserta} (${nama}) ditambahkan ke kontingen ${kontingen.kode}.`, `peserta:${pid}`, kontingen.kode);

    return jsonResponse({ ok: true, id: pid, kode_peserta: kodePeserta });
  }

  if (action === 'pembina_update_peserta') {
    const pesertaId = Number(body.id || 0);
    const nama = String(body.nama || '').trim();
    const tglLahir = String(body.tanggal_lahir || '').trim();
    const kontak = String(body.kontak || '').trim();

    if (pesertaId <= 0 || !nama || !/^\d{4}-\d{2}-\d{2}$/.test(tglLahir)) {
      return jsonError('Data peserta tidak lengkap.', 400);
    }

    const existing = await db.prepare('SELECT * FROM peserta WHERE id = ? AND kontingen_id = ?').bind(pesertaId, kontingen.id).first();
    if (!existing) {
      return jsonError('Peserta tidak ditemukan pada kontingen Anda.', 404);
    }

    await db.prepare('UPDATE peserta SET nama = ?, tanggal_lahir = ?, kontak = ? WHERE id = ?').bind(nama, tglLahir, kontak, pesertaId).run();

    await writeLog(db, user, 'ubah_peserta', `Data peserta ${existing.kode_peserta} diubah (${existing.nama} -> ${nama}).`, `peserta:${pesertaId}`, kontingen.kode);
    return jsonResponse({ ok: true });
  }

  if (action === 'pembina_delete_peserta') {
    const pesertaId = Number(body.id || 0);
    const existing = await db.prepare('SELECT * FROM peserta WHERE id = ? AND kontingen_id = ?').bind(pesertaId, kontingen.id).first();
    if (!existing) {
      return jsonError('Peserta tidak ditemukan.', 404);
    }

    await db.prepare('DELETE FROM peserta WHERE id = ?').bind(pesertaId).run();
    await writeLog(db, user, 'hapus_peserta', `Peserta ${existing.kode_peserta} (${existing.nama}) dihapus dari kontingen ${kontingen.kode}.`, `peserta:${pesertaId}`, kontingen.kode);
    return jsonResponse({ ok: true });
  }

  return jsonError('Aksi pembina tidak dikenal.', 404);
}
