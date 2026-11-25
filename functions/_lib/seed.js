import {
  nowIso,
  addDaysDate,
  currentYearJakarta,
  hashPassword,
  recalculateNilaiAkhirPos,
  writeLog,
} from './helpers.js';

async function ensureSchema(db) {
  const exists = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='akun'").first();
  if (exists) {
    const { results: cols } = await db.prepare('PRAGMA table_info(sekolah)').all();
    const colNames = new Set((cols || []).map((c) => c.name));
    const alterStmts = [];
    if (!colNames.has('npsn')) alterStmts.push(db.prepare("ALTER TABLE sekolah ADD COLUMN npsn TEXT NOT NULL DEFAULT ''"));
    if (!colNames.has('jenjang')) alterStmts.push(db.prepare("ALTER TABLE sekolah ADD COLUMN jenjang TEXT NOT NULL DEFAULT ''"));
    if (!colNames.has('kecamatan')) alterStmts.push(db.prepare("ALTER TABLE sekolah ADD COLUMN kecamatan TEXT NOT NULL DEFAULT ''"));
    if (!colNames.has('alamat')) alterStmts.push(db.prepare("ALTER TABLE sekolah ADD COLUMN alamat TEXT NOT NULL DEFAULT ''"));
    if (alterStmts.length > 0) await db.batch(alterStmts);
    return;
  }

  const ddl = [
    `CREATE TABLE IF NOT EXISTS akun (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      nama TEXT NOT NULL,
      peran TEXT NOT NULL CHECK(peran IN ('pembina', 'juri', 'admin')),
      no_wa TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      wajib_ganti_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS kegiatan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tahun INTEGER NOT NULL UNIQUE,
      nama TEXT NOT NULL,
      tingkat_aktif TEXT NOT NULL,
      tanggal TEXT NOT NULL,
      hari_kunci TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sekolah (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nama TEXT NOT NULL UNIQUE,
      npsn TEXT NOT NULL DEFAULT '',
      jenjang TEXT NOT NULL DEFAULT '',
      kecamatan TEXT NOT NULL DEFAULT '',
      alamat TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS kontingen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kegiatan_id INTEGER NOT NULL REFERENCES kegiatan(id) ON DELETE CASCADE,
      sekolah_id INTEGER NOT NULL REFERENCES sekolah(id),
      tingkat TEXT NOT NULL CHECK(tingkat IN ('Mula', 'Madya', 'Wira')),
      jenis TEXT NOT NULL CHECK(jenis IN ('putra', 'putri', 'gabungan')),
      kode TEXT NOT NULL,
      pembina_id INTEGER NOT NULL REFERENCES akun(id),
      status TEXT NOT NULL DEFAULT 'terbuka' CHECK(status IN ('terbuka', 'terkunci')),
      created_at TEXT NOT NULL,
      UNIQUE(kegiatan_id, kode),
      UNIQUE(kegiatan_id, pembina_id)
    )`,
    `CREATE TABLE IF NOT EXISTS peserta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kontingen_id INTEGER NOT NULL REFERENCES kontingen(id) ON DELETE CASCADE,
      kegiatan_id INTEGER NOT NULL REFERENCES kegiatan(id) ON DELETE CASCADE,
      kode_peserta TEXT NOT NULL,
      nama TEXT NOT NULL,
      tanggal_lahir TEXT NOT NULL,
      kontak TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(kegiatan_id, kode_peserta)
    )`,
    `CREATE TABLE IF NOT EXISTS pos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kegiatan_id INTEGER NOT NULL REFERENCES kegiatan(id) ON DELETE CASCADE,
      nama TEXT NOT NULL,
      urutan_tiebreaker INTEGER NOT NULL DEFAULT 1,
      jumlah_juri INTEGER NOT NULL DEFAULT 1 CHECK(jumlah_juri BETWEEN 1 AND 3),
      cara_gabung TEXT NOT NULL DEFAULT 'rata_rata' CHECK(cara_gabung IN ('jumlah', 'rata_rata')),
      pakai_timer INTEGER NOT NULL DEFAULT 0,
      pakai_bidak INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS penugasan_juri (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pos_id INTEGER NOT NULL REFERENCES pos(id) ON DELETE CASCADE,
      juri_id INTEGER NOT NULL REFERENCES akun(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      UNIQUE(pos_id, juri_id)
    )`,
    `CREATE TABLE IF NOT EXISTS rubrik (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pos_id INTEGER NOT NULL REFERENCES pos(id) ON DELETE CASCADE,
      nama TEXT NOT NULL,
      komponen TEXT NOT NULL DEFAULT 'Umum' CHECK(komponen IN ('Umum', 'Teori', 'Praktik')),
      nilai_maksimal REAL NOT NULL,
      urutan INTEGER NOT NULL DEFAULT 1
    )`,
    `CREATE TABLE IF NOT EXISTS sesi_penilaian (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_session_uuid TEXT NOT NULL UNIQUE,
      kegiatan_id INTEGER NOT NULL REFERENCES kegiatan(id) ON DELETE CASCADE,
      kontingen_id INTEGER NOT NULL REFERENCES kontingen(id) ON DELETE CASCADE,
      pos_id INTEGER NOT NULL REFERENCES pos(id) ON DELETE CASCADE,
      juri_id INTEGER NOT NULL REFERENCES akun(id),
      status TEXT NOT NULL DEFAULT 'berjalan' CHECK(status IN ('berjalan', 'draf', 'selesai', 'dibatalkan')),
      timer_detik INTEGER NOT NULL DEFAULT 0,
      bidak REAL NOT NULL DEFAULT 0,
      reprint_count INTEGER NOT NULL DEFAULT 0,
      waktu_mulai TEXT NOT NULL,
      waktu_selesai TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS kehadiran (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sesi_id INTEGER NOT NULL REFERENCES sesi_penilaian(id) ON DELETE CASCADE,
      peserta_id INTEGER NOT NULL REFERENCES peserta(id) ON DELETE CASCADE,
      peran_di_pos TEXT NOT NULL,
      UNIQUE(sesi_id, peserta_id)
    )`,
    `CREATE TABLE IF NOT EXISTS nilai_juri (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid_unik TEXT NOT NULL UNIQUE,
      sesi_id INTEGER NOT NULL REFERENCES sesi_penilaian(id) ON DELETE CASCADE,
      juri_id INTEGER NOT NULL REFERENCES akun(id),
      rubrik_id INTEGER NOT NULL REFERENCES rubrik(id) ON DELETE CASCADE,
      nilai REAL NOT NULL,
      timer INTEGER NOT NULL DEFAULT 0,
      bidak REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(sesi_id, juri_id, rubrik_id)
    )`,
    `CREATE TABLE IF NOT EXISTS nilai_akhir_pos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kegiatan_id INTEGER NOT NULL REFERENCES kegiatan(id) ON DELETE CASCADE,
      kontingen_id INTEGER NOT NULL REFERENCES kontingen(id) ON DELETE CASCADE,
      pos_id INTEGER NOT NULL REFERENCES pos(id) ON DELETE CASCADE,
      nilai_akhir REAL NOT NULL DEFAULT 0,
      total_timer INTEGER NOT NULL DEFAULT 0,
      bidak REAL NOT NULL DEFAULT 0,
      has_revisi INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      UNIQUE(kontingen_id, pos_id)
    )`,
    `CREATE TABLE IF NOT EXISTS koreksi (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sesi_id INTEGER NOT NULL REFERENCES sesi_penilaian(id) ON DELETE CASCADE,
      detail_lama TEXT NOT NULL,
      detail_baru TEXT NOT NULL,
      nilai_lama REAL NOT NULL,
      nilai_baru REAL NOT NULL,
      alasan TEXT NOT NULL,
      juri_pengaju_id INTEGER NOT NULL REFERENCES akun(id),
      admin_penyetuju_id INTEGER REFERENCES akun(id),
      status TEXT NOT NULL DEFAULT 'diajukan' CHECK(status IN ('diajukan', 'disetujui', 'ditolak')),
      catatan_admin TEXT NOT NULL DEFAULT '',
      waktu_pengajuan TEXT NOT NULL,
      waktu_keputusan TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      waktu TEXT NOT NULL,
      pelaku_id INTEGER,
      pelaku_nama TEXT NOT NULL,
      pelaku_peran TEXT NOT NULL,
      jenis_aktivitas TEXT NOT NULL,
      rujukan_data TEXT NOT NULL DEFAULT '',
      kontingen_kode TEXT NOT NULL DEFAULT '',
      pos_nama TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS rate_limits (
      ip TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(ip, window_start)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_peserta_kode ON peserta(kode_peserta)`,
    `CREATE INDEX IF NOT EXISTS idx_sesi_status ON sesi_penilaian(kegiatan_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_log_waktu ON log(waktu DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_nilai_akhir_keg ON nilai_akhir_pos(kegiatan_id)`,
  ];

  await db.batch(ddl.map((sql) => db.prepare(sql)));
}

export async function ensureSeeded(db) {
  await ensureSchema(db);
  const cntRow = await db.prepare('SELECT COUNT(*) AS cnt FROM akun').first();
  if (cntRow && Number(cntRow.cnt) > 0) return;

  const now = nowIso();
  const year = currentYearJakarta();
  const futureLock = addDaysDate(30);
  const eventDate = addDaysDate(32);

  const accounts = [
    ['admin', 'Admin PMI Purbalingga', 'admin', '628112600001', 'admin123', 0],
    ['juri1', 'dr. Rina Wijaya (Juri PP)', 'juri', '628112600101', 'juri123', 0],
    ['juri2', 'Budi Santoso, S.Kep (Juri PP)', 'juri', '628112600102', 'juri123', 0],
    ['juri3', 'Siti Aminah, S.Pd (Juri Tandu & KKR)', 'juri', '628112600103', 'juri123', 0],
    ['pembina1', 'Ahmad Fauzi (Pembina)', 'pembina', '628122700001', 'pembina123', 0],
    ['pembina2', 'Dewi Lestari (Pembina)', 'pembina', '628122700002', 'pembina123', 0],
    ['pembina3', 'Hendra Pratama (Pembina)', 'pembina', '628122700003', 'pembina123', 0],
  ];

  const ids = {};
  for (const [u, n, r, wa, pw, force] of accounts) {
    const pwHash = await hashPassword(pw);
    const res = await db.prepare(
      'INSERT INTO akun (username, nama, peran, no_wa, password_hash, wajib_ganti_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(u, n, r, wa, pwHash, force, now).run();
    ids[u] = Number(res.meta.last_row_id);
  }

  const kegRes = await db.prepare(
    'INSERT INTO kegiatan (tahun, nama, tingkat_aktif, tanggal, hari_kunci, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
  ).bind(
    year,
    `Jumbara PMR PMI Kabupaten Purbalingga ${year}`,
    JSON.stringify(['Mula', 'Madya', 'Wira']),
    eventDate,
    futureLock,
    now
  ).run();
  const kegId = Number(kegRes.meta.last_row_id);

  const schools = [
    'SD Negeri 1 Purbalingga Lor',
    'SD Negeri 1 Bobotsari',
    'MI Muhammadiyah Kalimanah',
    'SMP Negeri 1 Purbalingga',
    'SMP Negeri 2 Purbalingga',
    'MTs Negeri 1 Purbalingga',
    'SMA Negeri 1 Purbalingga',
    'SMK Negeri 1 Purbalingga',
  ];
  const schIds = {};
  for (const s of schools) {
    const res = await db.prepare('INSERT INTO sekolah (nama) VALUES (?)').bind(s).run();
    schIds[s] = Number(res.meta.last_row_id);
  }

  const kontingens = [
    [schIds['SD Negeri 1 Purbalingga Lor'], 'Mula', 'gabungan', 'MU001', ids.pembina1],
    [schIds['SD Negeri 1 Bobotsari'], 'Mula', 'putri', 'MU002', ids.pembina2],
    [schIds['SMP Negeri 1 Purbalingga'], 'Madya', 'putra', 'MA001', ids.pembina3],
  ];
  const kIds = {};
  for (const [sid, tingkat, jenis, kode, pid] of kontingens) {
    const res = await db.prepare(
      "INSERT INTO kontingen (kegiatan_id, sekolah_id, tingkat, jenis, kode, pembina_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'terbuka', ?)"
    ).bind(kegId, sid, tingkat, jenis, kode, pid, now).run();
    kIds[kode] = Number(res.meta.last_row_id);
  }

  const pesertas = [
    [kIds.MU001, 'MU00101', 'Nadia Putri Ramadhani', '2015-04-12', '08131110001'],
    [kIds.MU001, 'MU00102', 'Rafka Aditya Pratama', '2014-11-03', ''],
    [kIds.MU001, 'MU00103', 'Aisyah Nur Hidayah', '2015-08-21', ''],
    [kIds.MU001, 'MU00104', 'Bagas Saputra', '2014-05-19', ''],
    [kIds.MU002, 'MU00201', 'Zahra Khairunnisa', '2015-09-14', ''],
    [kIds.MU002, 'MU00202', 'Kirana Salsabila', '2015-01-27', ''],
    [kIds.MU002, 'MU00203', 'Melati Kusuma', '2014-10-08', ''],
    [kIds.MA001, 'MA00101', 'Dimas Prasetyo', '2012-03-17', '08561112233'],
    [kIds.MA001, 'MA00102', 'Fajar Nugroho', '2012-07-02', ''],
    [kIds.MA001, 'MA00103', 'Gilang Ramadhan', '2013-02-11', ''],
  ];
  const pesertaIds = {};
  for (const [kid, kode, nama, tgl, kontak] of pesertas) {
    const res = await db.prepare(
      'INSERT INTO peserta (kontingen_id, kegiatan_id, kode_peserta, nama, tanggal_lahir, kontak, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(kid, kegId, kode, nama, tgl, kontak, now).run();
    pesertaIds[kode] = Number(res.meta.last_row_id);
  }

  const posConfigs = [
    {
      nama: 'Pertolongan Pertama',
      urutan_tiebreaker: 1,
      jumlah_juri: 2,
      cara_gabung: 'rata_rata',
      pakai_timer: 1,
      pakai_bidak: 0,
      juris: [ids.juri1, ids.juri2],
      rubriks: [
        ['Tes Tertulis Kepalangmerahan & PP', 'Teori', 30, 1],
        ['Penilaian Dini & Pemeriksaan Fisik', 'Praktik', 25, 2],
        ['Penanganan Luka & Pembidaian', 'Praktik', 30, 3],
        ['Kerapian, Kerjasama & Komunikasi', 'Praktik', 15, 4],
      ],
    },
    {
      nama: 'Pasang Bongkar Tandu',
      urutan_tiebreaker: 2,
      jumlah_juri: 1,
      cara_gabung: 'jumlah',
      pakai_timer: 1,
      pakai_bidak: 1,
      juris: [ids.juri3],
      rubriks: [
        ['Ketepatan Simpul & Ikatan', 'Praktik', 40, 1],
        ['Kekuatan & Keseimbangan Tandu', 'Praktik', 40, 2],
        ['Keamanan Evakuasi Korban', 'Praktik', 20, 3],
      ],
    },
    {
      nama: 'Kesehatan & Kebersihan Remaja',
      urutan_tiebreaker: 3,
      jumlah_juri: 1,
      cara_gabung: 'rata_rata',
      pakai_timer: 0,
      pakai_bidak: 0,
      juris: [ids.juri3],
      rubriks: [
        ['Penguasaan Materi Kesehatan', 'Teori', 40, 1],
        ['Penyampaian & Media Edukasi', 'Praktik', 40, 2],
        ['Tanya Jawab & Sikap', 'Praktik', 20, 3],
      ],
    },
  ];

  const posIds = {};
  const rubIdsByPos = {};
  for (const cfg of posConfigs) {
    const pRes = await db.prepare(
      'INSERT INTO pos (kegiatan_id, nama, urutan_tiebreaker, jumlah_juri, cara_gabung, pakai_timer, pakai_bidak, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(kegId, cfg.nama, cfg.urutan_tiebreaker, cfg.jumlah_juri, cfg.cara_gabung, cfg.pakai_timer, cfg.pakai_bidak, now).run();
    const pid = Number(pRes.meta.last_row_id);
    posIds[cfg.nama] = pid;
    rubIdsByPos[pid] = [];

    for (const jid of cfg.juris) {
      await db.prepare('INSERT INTO penugasan_juri (pos_id, juri_id, created_at) VALUES (?, ?, ?)').bind(pid, jid, now).run();
    }
    for (const [rNama, komp, maks, urutan] of cfg.rubriks) {
      const rRes = await db.prepare(
        'INSERT INTO rubrik (pos_id, nama, komponen, nilai_maksimal, urutan) VALUES (?, ?, ?, ?, ?)'
      ).bind(pid, rNama, komp, maks, urutan).run();
      rubIdsByPos[pid].push(Number(rRes.meta.last_row_id));
    }
  }

  async function seedSession(uuid, kontingenId, posId, juriId, scores, timer, bidak, attendees) {
    const sRes = await db.prepare(
      "INSERT INTO sesi_penilaian (client_session_uuid, kegiatan_id, kontingen_id, pos_id, juri_id, status, timer_detik, bidak, waktu_mulai, waktu_selesai) VALUES (?, ?, ?, ?, ?, 'selesai', ?, ?, ?, ?)"
    ).bind(uuid, kegId, kontingenId, posId, juriId, timer, bidak, now, now).run();
    const sesiId = Number(sRes.meta.last_row_id);

    for (const [pesId, role] of attendees) {
      await db.prepare('INSERT INTO kehadiran (sesi_id, peserta_id, peran_di_pos) VALUES (?, ?, ?)').bind(sesiId, pesId, role).run();
    }

    const rIds = rubIdsByPos[posId];
    for (let idx = 0; idx < rIds.length; idx++) {
      const rubId = rIds[idx];
      await db.prepare(
        'INSERT INTO nilai_juri (uid_unik, sesi_id, juri_id, rubrik_id, nilai, timer, bidak, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(`${uuid}-r${rubId}`, sesiId, juriId, rubId, scores[idx] ?? 0, timer, bidak, now).run();
    }

    await recalculateNilaiAkhirPos(db, kontingenId, posId);
  }

  const ppId = posIds['Pertolongan Pertama'];
  const tanduId = posIds['Pasang Bongkar Tandu'];
  const kkrId = posIds['Kesehatan & Kebersihan Remaja'];

  await seedSession('seed-mu001-pp-j1', kIds.MU001, ppId, ids.juri1, [27, 23, 28, 14], 245, 0, [
    [pesertaIds.MU00101, 'Pemimpin'],
    [pesertaIds.MU00102, 'Pelaku'],
    [pesertaIds.MU00103, 'Narator'],
  ]);
  await seedSession('seed-mu001-pp-j2', kIds.MU001, ppId, ids.juri2, [27, 22, 27, 13], 245, 0, [
    [pesertaIds.MU00101, 'Pemimpin'],
    [pesertaIds.MU00102, 'Pelaku'],
    [pesertaIds.MU00103, 'Narator'],
  ]);
  await seedSession('seed-mu002-tandu-j3', kIds.MU002, tanduId, ids.juri3, [36, 35, 18], 198, 12, [
    [pesertaIds.MU00201, 'Pemimpin'],
    [pesertaIds.MU00202, 'Pelaku'],
  ]);

  await db.prepare(
    "INSERT INTO sesi_penilaian (client_session_uuid, kegiatan_id, kontingen_id, pos_id, juri_id, status, timer_detik, bidak, waktu_mulai) VALUES ('seed-mu002-pp-live', ?, ?, ?, ?, 'berjalan', 0, 0, ?)"
  ).bind(kegId, kIds.MU002, ppId, ids.juri1, now).run();

  await seedSession('seed-mu001-kkr-j3', kIds.MU001, kkrId, ids.juri3, [35, 36, 17], 0, 0, [
    [pesertaIds.MU00104, 'Penyuluh'],
  ]);

  await writeLog(
    db,
    { id: ids.admin, nama: 'Admin PMI Purbalingga', peran: 'admin' },
    'inisialisasi',
    'Data awal demo Jumbara PMR berhasil dibuat.',
    `kegiatan:${kegId}`
  );
}
