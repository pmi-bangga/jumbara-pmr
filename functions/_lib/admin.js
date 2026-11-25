import {
  nowIso,
  jsonResponse,
  jsonError,
  normalizeWa,
  hashPassword,
  generateTempPassword,
  writeLog,
  getActiveKegiatan,
  recalculateNilaiAkhirPos,
  getReceiptPayload,
} from './helpers.js';

export async function computeStandingsAndReports(db, kegiatanId) {
  const { results: posListRaw } = await db.prepare('SELECT * FROM pos WHERE kegiatan_id = ? ORDER BY id ASC').bind(kegiatanId).all();
  const posList = posListRaw || [];

  const posTieOrdered = [...posList].sort((a, b) => {
    const diff = Number(a.urutan_tiebreaker) - Number(b.urutan_tiebreaker);
    return diff !== 0 ? diff : Number(a.id) - Number(b.id);
  });

  const { results: kontingens } = await db.prepare(`
    SELECT k.id, k.kode, k.tingkat, k.jenis, k.status, s.nama AS sekolah_nama,
           (SELECT COUNT(*) FROM peserta p WHERE p.kontingen_id = k.id) AS jumlah_peserta
    FROM kontingen k
    JOIN sekolah s ON s.id = k.sekolah_id
    WHERE k.kegiatan_id = ?
    ORDER BY k.kode ASC
  `).bind(kegiatanId).all();

  const { results: napRows } = await db.prepare('SELECT * FROM nilai_akhir_pos WHERE kegiatan_id = ?').bind(kegiatanId).all();
  const napMap = {};
  for (const n of napRows || []) {
    const kid = Number(n.kontingen_id);
    if (!napMap[kid]) napMap[kid] = {};
    napMap[kid][Number(n.pos_id)] = n;
  }

  const timerPosIds = posList.filter((p) => Number(p.pakai_timer) === 1).map((p) => Number(p.id));
  const bidakPosIds = posList.filter((p) => Number(p.pakai_bidak) === 1).map((p) => Number(p.id));

  const standings = (kontingens || []).map((k) => {
    const kid = Number(k.id);
    let totalNilai = 0;
    let totalTimer = 0;
    let totalBidak = 0;
    const posScores = {};

    for (const p of posList) {
      const pid = Number(p.id);
      const entry = napMap[kid]?.[pid] || null;
      if (entry) {
        const val = Number(entry.nilai_akhir);
        totalNilai += val;
        if (timerPosIds.includes(pid)) totalTimer += Number(entry.total_timer);
        if (bidakPosIds.includes(pid)) totalBidak += Number(entry.bidak);
        posScores[pid] = {
          nilai_akhir: val,
          total_timer: Number(entry.total_timer),
          bidak: Number(entry.bidak),
          has_revisi: Boolean(entry.has_revisi),
        };
      } else {
        posScores[pid] = null;
      }
    }

    return {
      kontingen_id: kid,
      kode: k.kode,
      sekolah_nama: k.sekolah_nama,
      tingkat: k.tingkat,
      jenis: k.jenis,
      jumlah_peserta: Number(k.jumlah_peserta),
      total_nilai: Math.round(totalNilai * 100) / 100,
      total_timer: totalTimer,
      total_bidak: Math.round(totalBidak * 100) / 100,
      pos_scores: posScores,
    };
  });

  const ranked = [...standings].sort((a, b) => {
    if (b.total_nilai !== a.total_nilai) return b.total_nilai - a.total_nilai;
    if (a.total_timer !== b.total_timer) return a.total_timer - b.total_timer;
    if (b.total_bidak !== a.total_bidak) return b.total_bidak - a.total_bidak;
    for (const pos of posTieOrdered) {
      const pid = Number(pos.id);
      const va = a.pos_scores[pid]?.nilai_akhir ?? 0;
      const vb = b.pos_scores[pid]?.nilai_akhir ?? 0;
      if (vb !== va) return vb - va;
    }
    return a.kode.localeCompare(b.kode);
  }).map((row, idx) => ({ ...row, peringkat: idx + 1 }));

  const { results: pesertaPalingAktif } = await db.prepare(`
    SELECT p.id, p.kode_peserta, p.nama, p.tanggal_lahir, k.kode AS kontingen_kode, k.tingkat, s.nama AS sekolah_nama,
           COUNT(DISTINCT kh.sesi_id) AS jumlah_pos_diikuti
    FROM peserta p
    JOIN kontingen k ON k.id = p.kontingen_id
    JOIN sekolah s ON s.id = k.sekolah_id
    JOIN kehadiran kh ON kh.peserta_id = p.id
    JOIN sesi_penilaian sp ON sp.id = kh.sesi_id AND sp.status = 'selesai'
    WHERE p.kegiatan_id = ?
    GROUP BY p.id
    ORDER BY p.tanggal_lahir DESC, jumlah_pos_diikuti DESC, p.nama ASC
    LIMIT 10
  `).bind(kegiatanId).all();

  return {
    pos_list: posList,
    standings_by_kode: standings,
    juara_umum: ranked,
    peserta_paling_aktif: pesertaPalingAktif || [],
  };
}

function parseCsvRow(line, delimiter) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

export async function handleAdminAction(db, user, action, body, url) {
  if (action === 'admin_bootstrap') {
    const { results: kegRaw } = await db.prepare('SELECT * FROM kegiatan ORDER BY tahun DESC').all();
    const kegiatanList = (kegRaw || []).map((kg) => {
      let tingkat = [];
      try { tingkat = JSON.parse(kg.tingkat_aktif) || []; } catch { tingkat = []; }
      return {
        ...kg,
        id: Number(kg.id),
        tahun: Number(kg.tahun),
        is_active: Boolean(kg.is_active),
        tingkat_aktif: tingkat,
      };
    });

    const active = await getActiveKegiatan(db);
    const kegId = Number(url.searchParams.get('kegiatan_id') || (active ? active.id : 0));

    const { results: sekolah } = await db.prepare('SELECT * FROM sekolah ORDER BY nama ASC').all();
    const { results: akun } = await db.prepare('SELECT id, username, nama, peran, no_wa, wajib_ganti_password, created_at FROM akun ORDER BY peran ASC, nama ASC').all();

    const posList = [];
    let kontingenList = [];
    let pesertaList = [];
    let koreksiList = [];
    let reports = null;

    if (kegId > 0) {
      const { results: posRows } = await db.prepare('SELECT * FROM pos WHERE kegiatan_id = ? ORDER BY id ASC').bind(kegId).all();
      for (const p of posRows || []) {
        const { results: rubriks } = await db.prepare('SELECT * FROM rubrik WHERE pos_id = ? ORDER BY urutan ASC, id ASC').bind(p.id).all();
        const { results: juriDitugaskan } = await db.prepare(`
          SELECT a.id, a.username, a.nama, a.no_wa
          FROM penugasan_juri pj
          JOIN akun a ON a.id = pj.juri_id
          WHERE pj.pos_id = ?
          ORDER BY a.nama ASC
        `).bind(p.id).all();

        posList.push({
          ...p,
          id: Number(p.id),
          jumlah_juri: Number(p.jumlah_juri),
          urutan_tiebreaker: Number(p.urutan_tiebreaker),
          pakai_timer: Boolean(p.pakai_timer),
          pakai_bidak: Boolean(p.pakai_bidak),
          rubriks: rubriks || [],
          juri_ditugaskan: juriDitugaskan || [],
          juri_lengkap: (juriDitugaskan || []).length >= Number(p.jumlah_juri),
        });
      }

      const { results: kRows } = await db.prepare(`
        SELECT k.*, s.nama AS sekolah_nama, a.nama AS pembina_nama, a.no_wa AS pembina_wa
        FROM kontingen k
        JOIN sekolah s ON s.id = k.sekolah_id
        JOIN akun a ON a.id = k.pembina_id
        WHERE k.kegiatan_id = ?
        ORDER BY k.kode ASC
      `).bind(kegId).all();
      kontingenList = kRows || [];

      const { results: pRows } = await db.prepare(`
        SELECT p.*, k.kode AS kontingen_kode, k.tingkat, k.jenis, s.nama AS sekolah_nama
        FROM peserta p
        JOIN kontingen k ON k.id = p.kontingen_id
        JOIN sekolah s ON s.id = k.sekolah_id
        WHERE p.kegiatan_id = ?
        ORDER BY p.kode_peserta ASC
      `).bind(kegId).all();
      pesertaList = pRows || [];

      const { results: krRows } = await db.prepare(`
        SELECT kr.*, sp.kontingen_id, sp.pos_id, k.kode AS kontingen_kode, s.nama AS sekolah_nama,
               p.nama AS pos_nama, jp.nama AS juri_nama, ap.nama AS admin_nama
        FROM koreksi kr
        JOIN sesi_penilaian sp ON sp.id = kr.sesi_id
        JOIN kontingen k ON k.id = sp.kontingen_id
        JOIN sekolah s ON s.id = k.sekolah_id
        JOIN pos p ON p.id = sp.pos_id
        JOIN akun jp ON jp.id = kr.juri_pengaju_id
        LEFT JOIN akun ap ON ap.id = kr.admin_penyetuju_id
        WHERE sp.kegiatan_id = ?
        ORDER BY CASE WHEN kr.status = 'diajukan' THEN 0 ELSE 1 END, kr.id DESC
      `).bind(kegId).all();
      koreksiList = krRows || [];

      reports = await computeStandingsAndReports(db, kegId);
    }

    return jsonResponse({
      ok: true,
      kegiatan_active: active,
      kegiatan_list: kegiatanList,
      selected_kegiatan_id: kegId,
      sekolah: sekolah || [],
      akun: akun || [],
      pos_list: posList,
      kontingen_list: kontingenList,
      peserta_list: pesertaList,
      koreksi_list: koreksiList,
      reports,
    });
  }

  if (action === 'admin_save_kegiatan') {
    let id = Number(body.id || 0);
    const tahun = Number(body.tahun || 0);
    const nama = String(body.nama || '').trim();
    const tingkatAktif = body.tingkat_aktif;
    const tanggal = String(body.tanggal || '').trim();
    const hariKunci = String(body.hari_kunci || '').trim();
    const setActive = Boolean(body.is_active);

    if (tahun < 2024 || !nama || !Array.isArray(tingkatAktif) || tingkatAktif.length === 0 || !tanggal || !hariKunci) {
      return jsonError('Tahun, nama kegiatan, minimal 1 tingkat aktif, tanggal, dan hari kunci wajib diisi.', 400);
    }

    const validTingkat = ['Mula', 'Madya', 'Wira'].filter((t) => tingkatAktif.includes(t));
    if (validTingkat.length === 0) {
      return jsonError('Tingkat aktif tidak valid.', 400);
    }

    try {
      if (setActive) {
        await db.prepare('UPDATE kegiatan SET is_active = 0').run();
      }
      if (id > 0) {
        await db.prepare('UPDATE kegiatan SET tahun = ?, nama = ?, tingkat_aktif = ?, tanggal = ?, hari_kunci = ?, is_active = ? WHERE id = ?')
          .bind(tahun, nama, JSON.stringify(validTingkat), tanggal, hariKunci, setActive ? 1 : 0, id).run();
        await writeLog(db, user, 'ubah_kegiatan', `Kegiatan ${nama} (${tahun}) diperbarui.`, `kegiatan:${id}`);
      } else {
        const res = await db.prepare('INSERT INTO kegiatan (tahun, nama, tingkat_aktif, tanggal, hari_kunci, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(tahun, nama, JSON.stringify(validTingkat), tanggal, hariKunci, setActive ? 1 : 0, nowIso()).run();
        id = Number(res.meta.last_row_id);
        await writeLog(db, user, 'buat_kegiatan', `Kegiatan baru ${nama} (${tahun}) dibuat.`, `kegiatan:${id}`);
      }
    } catch {
      return jsonError('Gagal menyimpan kegiatan (pastikan tahun belum dipakai kegiatan lain).', 400);
    }
    return jsonResponse({ ok: true, id });
  }

  if (action === 'admin_import_sekolah') {
    const csvText = String(body.csv_text || '').replace(/^\uFEFF/, '').trim();
    if (!csvText) {
      return jsonError('Isi CSV sekolah kosong.', 400);
    }
    const lines = csvText.split(/\r\n|\r|\n/).filter((l) => l.trim() !== '');
    if (lines.length === 0) {
      return jsonError('Isi CSV sekolah kosong.', 400);
    }

    const firstLine = lines[0];
    const delimiter = firstLine.includes(';') ? ';' : ',';
    const headerCols = parseCsvRow(firstLine, delimiter).map((c) => c.toLowerCase());
    const hasHeader = headerCols.includes('nama') || headerCols.includes('npsn') || headerCols.includes('sekolah') || headerCols.includes('nama_sekolah');

    let idxNpsn = -1;
    let idxNama = 0;
    let idxJenjang = -1;
    let idxKec = -1;
    let idxAlamat = -1;

    if (hasHeader) {
      idxNpsn = headerCols.indexOf('npsn');
      idxNama = headerCols.findIndex((h) => ['nama', 'sekolah', 'nama_sekolah'].includes(h));
      if (idxNama < 0) idxNama = 0;
      idxJenjang = headerCols.indexOf('jenjang');
      idxKec = headerCols.indexOf('kecamatan');
      idxAlamat = headerCols.indexOf('alamat');
    } else if (parseCsvRow(firstLine, delimiter).length >= 4) {
      // Assume npsn;nama;jenjang;kecamatan;alamat even without header
      idxNpsn = 0;
      idxNama = 1;
      idxJenjang = 2;
      idxKec = 3;
      idxAlamat = 4;
    }

    const stmts = [];
    const startIdx = hasHeader ? 1 : 0;
    for (let i = startIdx; i < lines.length; i++) {
      const cols = parseCsvRow(lines[i], delimiter);
      const nama = String(cols[idxNama] || '').trim();
      if (!nama) continue;
      const npsn = idxNpsn >= 0 ? String(cols[idxNpsn] || '').trim() : '';
      const jenjang = idxJenjang >= 0 ? String(cols[idxJenjang] || '').trim() : '';
      const kecamatan = idxKec >= 0 ? String(cols[idxKec] || '').trim() : '';
      const alamat = idxAlamat >= 0 ? String(cols[idxAlamat] || '').trim() : '';

      stmts.push(
        db.prepare(`
          INSERT INTO sekolah (nama, npsn, jenjang, kecamatan, alamat)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(nama) DO UPDATE SET
            npsn = CASE WHEN excluded.npsn <> '' THEN excluded.npsn ELSE sekolah.npsn END,
            jenjang = CASE WHEN excluded.jenjang <> '' THEN excluded.jenjang ELSE sekolah.jenjang END,
            kecamatan = CASE WHEN excluded.kecamatan <> '' THEN excluded.kecamatan ELSE sekolah.kecamatan END,
            alamat = CASE WHEN excluded.alamat <> '' THEN excluded.alamat ELSE sekolah.alamat END
        `).bind(nama, npsn, jenjang, kecamatan, alamat)
      );
    }

    let totalChanges = 0;
    for (let i = 0; i < stmts.length; i += 100) {
      const chunk = stmts.slice(i, i + 100);
      const results = await db.batch(chunk);
      for (const r of results) {
        if (r.meta && r.meta.changes > 0) totalChanges++;
      }
    }

    await writeLog(db, user, 'impor_sekolah', `Impor CSV sekolah: ${stmts.length} baris diproses (${totalChanges} disimpan/diperbarui).`);
    return jsonResponse({ ok: true, added: stmts.length });
  }

  if (action === 'admin_save_pos') {
    let id = Number(body.id || 0);
    const kegiatanId = Number(body.kegiatan_id || 0);
    const nama = String(body.nama || '').trim();
    const urutanTie = Math.max(1, Number(body.urutan_tiebreaker || 1));
    const jumlahJuri = Math.min(3, Math.max(1, Number(body.jumlah_juri || 1)));
    const caraGabung = body.cara_gabung === 'jumlah' ? 'jumlah' : 'rata_rata';
    const pakaiTimer = body.pakai_timer ? 1 : 0;
    const pakaiBidak = body.pakai_bidak ? 1 : 0;
    const rubriks = body.rubriks;
    const juriIds = Array.isArray(body.juri_ids) ? body.juri_ids : [];

    if (kegiatanId <= 0 || !nama || !Array.isArray(rubriks) || rubriks.length === 0) {
      return jsonError('Nama pos, kegiatan, dan minimal 1 rubrik wajib diisi.', 400);
    }

    try {
      if (id > 0) {
        await db.prepare(
          'UPDATE pos SET nama = ?, urutan_tiebreaker = ?, jumlah_juri = ?, cara_gabung = ?, pakai_timer = ?, pakai_bidak = ? WHERE id = ? AND kegiatan_id = ?'
        ).bind(nama, urutanTie, jumlahJuri, caraGabung, pakaiTimer, pakaiBidak, id, kegiatanId).run();

        const keepIds = [];
        for (let idx = 0; idx < rubriks.length; idx++) {
          const r = rubriks[idx];
          const rid = Number(r.id || 0);
          const rNama = String(r.nama || '').trim();
          const komp = ['Umum', 'Teori', 'Praktik'].includes(r.komponen) ? r.komponen : 'Umum';
          const maks = Math.max(1, Number(r.nilai_maksimal || 10));
          if (!rNama) continue;
          if (rid > 0) {
            await db.prepare('UPDATE rubrik SET nama = ?, komponen = ?, nilai_maksimal = ?, urutan = ? WHERE id = ? AND pos_id = ?')
              .bind(rNama, komp, maks, idx + 1, rid, id).run();
            keepIds.push(rid);
          } else {
            const rRes = await db.prepare('INSERT INTO rubrik (pos_id, nama, komponen, nilai_maksimal, urutan) VALUES (?, ?, ?, ?, ?)')
              .bind(id, rNama, komp, maks, idx + 1).run();
            keepIds.push(Number(rRes.meta.last_row_id));
          }
        }
        if (keepIds.length > 0) {
          const ph = keepIds.map(() => '?').join(',');
          await db.prepare(`DELETE FROM rubrik WHERE pos_id = ? AND id NOT IN (${ph})`).bind(id, ...keepIds).run();
        }
      } else {
        const pRes = await db.prepare(
          'INSERT INTO pos (kegiatan_id, nama, urutan_tiebreaker, jumlah_juri, cara_gabung, pakai_timer, pakai_bidak, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(kegiatanId, nama, urutanTie, jumlahJuri, caraGabung, pakaiTimer, pakaiBidak, nowIso()).run();
        id = Number(pRes.meta.last_row_id);

        for (let idx = 0; idx < rubriks.length; idx++) {
          const r = rubriks[idx];
          const rNama = String(r.nama || '').trim();
          const komp = ['Umum', 'Teori', 'Praktik'].includes(r.komponen) ? r.komponen : 'Umum';
          const maks = Math.max(1, Number(r.nilai_maksimal || 10));
          if (!rNama) continue;
          await db.prepare('INSERT INTO rubrik (pos_id, nama, komponen, nilai_maksimal, urutan) VALUES (?, ?, ?, ?, ?)')
            .bind(id, rNama, komp, maks, idx + 1).run();
        }
      }

      await db.prepare('DELETE FROM penugasan_juri WHERE pos_id = ?').bind(id).run();
      for (const jid of juriIds) {
        const jidInt = Number(jid);
        if (jidInt > 0) {
          await db.prepare('INSERT OR IGNORE INTO penugasan_juri (pos_id, juri_id, created_at) VALUES (?, ?, ?)').bind(id, jidInt, nowIso()).run();
        }
      }

      await writeLog(db, user, 'pengaturan_pos', `Pengaturan pos "${nama}" disimpan (juri: ${jumlahJuri}, gabung: ${caraGabung}).`, `pos:${id}`, '', nama);
    } catch (err) {
      return jsonError(`Gagal menyimpan pengaturan pos: ${err.message}`, 400);
    }
    return jsonResponse({ ok: true, id });
  }

  if (action === 'admin_create_juri') {
    const nama = String(body.nama || '').trim();
    const username = String(body.username || '').trim().toLowerCase();
    const wa = normalizeWa(body.no_wa || '');
    const password = String(body.password || '');

    if (!nama || !username || !wa || password.length < 6) {
      return jsonError('Nama, username, nomor WhatsApp wajib, dan password (minimal 6 karakter) wajib diisi.', 400);
    }

    const exists = await db.prepare('SELECT id FROM akun WHERE username = ?').bind(username).first();
    if (exists) {
      return jsonError('Username sudah digunakan.', 400);
    }

    const pwHash = await hashPassword(password);
    const res = await db.prepare(
      "INSERT INTO akun (username, nama, peran, no_wa, password_hash, wajib_ganti_password, created_at) VALUES (?, ?, 'juri', ?, ?, 1, ?)"
    ).bind(username, nama, wa, pwHash, nowIso()).run();
    const id = Number(res.meta.last_row_id);

    await writeLog(db, user, 'buat_juri', `Akun juri baru dibuat: ${nama} (@${username}, WA: ${wa}).`, `akun:${id}`);
    return jsonResponse({ ok: true, id });
  }

  if (action === 'admin_reset_account') {
    const targetId = Number(body.akun_id || 0);
    const target = await db.prepare("SELECT * FROM akun WHERE id = ? AND peran IN ('pembina', 'juri')").bind(targetId).first();
    if (!target) {
      return jsonError('Hanya akun pembina atau juri yang dapat direset.', 404);
    }

    const tempPass = generateTempPassword(8);
    const pwHash = await hashPassword(tempPass);
    await db.prepare('UPDATE akun SET password_hash = ?, wajib_ganti_password = 1 WHERE id = ?').bind(pwHash, targetId).run();

    const waMessage = encodeURIComponent(`Halo ${target.nama}, password sementara akun Jumbara PMR Anda (${target.username}) adalah: ${tempPass} . Wajib diganti saat login pertama.`);
    const waUrl = `https://wa.me/${target.no_wa}?text=${waMessage}`;

    await writeLog(db, user, 'reset_akun', `Reset akun ${target.peran} ${target.nama} (@${target.username}). Password sementara dibuat untuk WA ${target.no_wa}.`, `akun:${targetId}`);

    return jsonResponse({
      ok: true,
      username: target.username,
      nama: target.nama,
      no_wa: target.no_wa,
      temp_password: tempPass,
      wa_url: waUrl,
    });
  }

  if (action === 'admin_update_peserta') {
    const pesertaId = Number(body.id || 0);
    const nama = String(body.nama || '').trim();
    const tglLahir = String(body.tanggal_lahir || '').trim();
    const kontak = String(body.kontak || '').trim();
    const alasan = String(body.alasan || '').trim();

    if (pesertaId <= 0 || !nama || !/^\d{4}-\d{2}-\d{2}$/.test(tglLahir) || !alasan) {
      return jsonError('Data peserta dan alasan perubahan wajib diisi.', 400);
    }

    const existing = await db.prepare('SELECT p.*, k.kode AS kontingen_kode FROM peserta p JOIN kontingen k ON k.id = p.kontingen_id WHERE p.id = ?').bind(pesertaId).first();
    if (!existing) {
      return jsonError('Peserta tidak ditemukan.', 404);
    }

    await db.prepare('UPDATE peserta SET nama = ?, tanggal_lahir = ?, kontak = ? WHERE id = ?').bind(nama, tglLahir, kontak, pesertaId).run();

    await writeLog(
      db,
      user,
      'ubah_data_admin',
      `Admin mengubah peserta ${existing.kode_peserta} (${existing.nama} -> ${nama}). Alasan: ${alasan}`,
      `peserta:${pesertaId}`,
      existing.kontingen_kode
    );
    return jsonResponse({ ok: true });
  }

  if (action === 'admin_toggle_kontingen_lock') {
    const kid = Number(body.kontingen_id || 0);
    const status = body.status === 'terkunci' ? 'terkunci' : 'terbuka';
    const alasan = String(body.alasan || 'Pengaturan status kunci oleh admin').trim();

    const kont = await db.prepare('SELECT * FROM kontingen WHERE id = ?').bind(kid).first();
    if (!kont) return jsonError('Kontingen tidak ditemukan.', 404);

    await db.prepare('UPDATE kontingen SET status = ? WHERE id = ?').bind(status, kid).run();
    await writeLog(db, user, 'ubah_kunci_kontingen', `Status kontingen ${kont.kode} diubah menjadi ${status}. Alasan: ${alasan}`, `kontingen:${kid}`, kont.kode);
    return jsonResponse({ ok: true });
  }

  if (action === 'admin_decide_correction') {
    const koreksiId = Number(body.koreksi_id || 0);
    const decision = body.decision === 'disetujui' ? 'disetujui' : 'ditolak';
    const catatan = String(body.catatan_admin || '').trim();

    const kr = await db.prepare(`
      SELECT kr.*, sp.kontingen_id, sp.pos_id, sp.juri_id, k.kode AS kontingen_kode, p.nama AS pos_nama
      FROM koreksi kr
      JOIN sesi_penilaian sp ON sp.id = kr.sesi_id
      JOIN kontingen k ON k.id = sp.kontingen_id
      JOIN pos p ON p.id = sp.pos_id
      WHERE kr.id = ? AND kr.status = 'diajukan'
    `).bind(koreksiId).first();

    if (!kr) {
      return jsonError('Pengajuan koreksi tidak ditemukan atau sudah diproses.', 404);
    }

    const now = nowIso();
    await db.prepare('UPDATE koreksi SET status = ?, admin_penyetuju_id = ?, catatan_admin = ?, waktu_keputusan = ? WHERE id = ?')
      .bind(decision, user.id, catatan, now, koreksiId).run();

    if (decision === 'disetujui') {
      const detailBaru = JSON.parse(kr.detail_baru || '{}');
      const newTimer = Number(detailBaru.timer_detik || 0);
      const newBidak = Number(detailBaru.bidak || 0);

      await db.prepare('UPDATE sesi_penilaian SET timer_detik = ?, bidak = ? WHERE id = ?').bind(newTimer, newBidak, kr.sesi_id).run();
      for (const sc of detailBaru.scores || []) {
        await db.prepare('UPDATE nilai_juri SET nilai = ?, timer = ?, bidak = ? WHERE sesi_id = ? AND rubrik_id = ?')
          .bind(Number(sc.nilai), newTimer, newBidak, kr.sesi_id, Number(sc.rubrik_id)).run();
      }
      await recalculateNilaiAkhirPos(db, Number(kr.kontingen_id), Number(kr.pos_id));
    }

    await writeLog(
      db,
      user,
      'keputusan_koreksi',
      `Koreksi #${koreksiId} (${kr.kontingen_kode} - ${kr.pos_nama}) ${decision} (${kr.nilai_lama} -> ${kr.nilai_baru}). Alasan juri: ${kr.alasan}`,
      `koreksi:${koreksiId}`,
      kr.kontingen_kode,
      kr.pos_nama
    );
    return jsonResponse({ ok: true });
  }

  if (action === 'admin_logs') {
    const where = ['1=1'];
    const params = [];

    const jenis = (url.searchParams.get('jenis') || '').trim();
    const kontingen = (url.searchParams.get('kontingen') || '').trim();
    const pos = (url.searchParams.get('pos') || '').trim();
    const pelaku = (url.searchParams.get('pelaku') || '').trim();
    const qRaw = (url.searchParams.get('q') || '').trim();

    if (jenis) { where.push('jenis_aktivitas = ?'); params.push(jenis); }
    if (kontingen) { where.push('UPPER(kontingen_kode) LIKE ?'); params.push(`%${kontingen.toUpperCase()}%`); }
    if (pos) { where.push('LOWER(pos_nama) LIKE ?'); params.push(`%${pos.toLowerCase()}%`); }
    if (pelaku) { where.push('LOWER(pelaku_nama) LIKE ?'); params.push(`%${pelaku.toLowerCase()}%`); }
    if (qRaw) {
      const q = `%${qRaw.toLowerCase()}%`;
      where.push('(LOWER(detail) LIKE ? OR LOWER(pelaku_nama) LIKE ? OR LOWER(kontingen_kode) LIKE ? OR LOWER(pos_nama) LIKE ?)');
      params.push(q, q, q, q);
    }

    const sql = `SELECT * FROM log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 300`;
    const { results: logs } = await db.prepare(sql).bind(...params).all();
    const { results: typeRows } = await db.prepare('SELECT DISTINCT jenis_aktivitas FROM log ORDER BY jenis_aktivitas ASC').all();
    const activityTypes = (typeRows || []).map((r) => r.jenis_aktivitas);

    return jsonResponse({ ok: true, logs: logs || [], activity_types: activityTypes });
  }

  if (action === 'admin_detailed_report') {
    let kegId = Number(url.searchParams.get('kegiatan_id') || 0);
    if (kegId <= 0) {
      const act = await getActiveKegiatan(db);
      kegId = act ? Number(act.id) : 0;
    }
    if (kegId <= 0) return jsonError('Kegiatan tidak ditemukan.', 404);

    const { results: kontList } = await db.prepare(`
      SELECT k.id, k.kode, k.tingkat, k.jenis, s.nama AS sekolah_nama
      FROM kontingen k JOIN sekolah s ON s.id = k.sekolah_id
      WHERE k.kegiatan_id = ? ORDER BY k.kode ASC
    `).bind(kegId).all();

    const { results: posRows } = await db.prepare('SELECT id FROM pos WHERE kegiatan_id = ? ORDER BY id ASC').bind(kegId).all();

    const receipts = [];
    for (const k of kontList || []) {
      for (const p of posRows || []) {
        const r = await getReceiptPayload(db, kegId, k.kode, Number(p.id));
        if (r && r.juri_breakdown.length > 0) {
          receipts.push(r);
        }
      }
    }

    return jsonResponse({
      ok: true,
      receipts,
      summary: await computeStandingsAndReports(db, kegId),
    });
  }

  return jsonError('Aksi admin tidak dikenal.', 404);
}
