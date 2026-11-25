<?php
declare(strict_types=1);

require_once __DIR__ . '/helpers.php';

function seed_initial_data(PDO $pdo): void {
    $now = now_iso();
    $year = (int)date('Y');
    $futureLock = (new DateTimeImmutable('now', new DateTimeZone('Asia/Jakarta')))
        ->modify('+30 days')
        ->format('Y-m-d');
    $eventDate = (new DateTimeImmutable('now', new DateTimeZone('Asia/Jakarta')))
        ->modify('+32 days')
        ->format('Y-m-d');

    // Accounts: admin, 3 juri, 3 pembina
    $accounts = [
        ['admin', 'Admin PMI Purbalingga', 'admin', '628112600001', 'admin123', 0],
        ['juri1', 'dr. Rina Wijaya (Juri PP)', 'juri', '628112600101', 'juri123', 0],
        ['juri2', 'Budi Santoso, S.Kep (Juri PP)', 'juri', '628112600102', 'juri123', 0],
        ['juri3', 'Siti Aminah, S.Pd (Juri Tandu & KKR)', 'juri', '628112600103', 'juri123', 0],
        ['pembina1', 'Ahmad Fauzi (Pembina)', 'pembina', '628122700001', 'pembina123', 0],
        ['pembina2', 'Dewi Lestari (Pembina)', 'pembina', '628122700002', 'pembina123', 0],
        ['pembina3', 'Hendra Pratama (Pembina)', 'pembina', '628122700003', 'pembina123', 0],
    ];

    $accStmt = $pdo->prepare('
        INSERT INTO akun (username, nama, peran, no_wa, password_hash, wajib_ganti_password, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ');
    $ids = [];
    foreach ($accounts as [$u, $n, $r, $wa, $pw, $force]) {
        $accStmt->execute([$u, $n, $r, $wa, password_hash($pw, PASSWORD_DEFAULT), $force, $now]);
        $ids[$u] = (int)$pdo->lastInsertId();
    }

    // Kegiatan
    $pdo->prepare('
        INSERT INTO kegiatan (tahun, nama, tingkat_aktif, tanggal, hari_kunci, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
    ')->execute([
        $year,
        'Jumbara PMR PMI Kabupaten Purbalingga ' . $year,
        json_encode(['Mula', 'Madya', 'Wira']),
        $eventDate,
        $futureLock,
        $now,
    ]);
    $kegId = (int)$pdo->lastInsertId();

    // Sekolah list
    $schools = [
        'SD Negeri 1 Purbalingga Lor',
        'SD Negeri 1 Bobotsari',
        'MI Muhammadiyah Kalimanah',
        'SMP Negeri 1 Purbalingga',
        'SMP Negeri 2 Purbalingga',
        'MTs Negeri 1 Purbalingga',
        'SMA Negeri 1 Purbalingga',
        'SMK Negeri 1 Purbalingga',
    ];
    $schStmt = $pdo->prepare('INSERT INTO sekolah (nama) VALUES (?)');
    $schIds = [];
    foreach ($schools as $s) {
        $schStmt->execute([$s]);
        $schIds[$s] = (int)$pdo->lastInsertId();
    }

    // Kontingen
    $kontingens = [
        [$schIds['SD Negeri 1 Purbalingga Lor'], 'Mula', 'gabungan', 'MU001', $ids['pembina1']],
        [$schIds['SD Negeri 1 Bobotsari'], 'Mula', 'putri', 'MU002', $ids['pembina2']],
        [$schIds['SMP Negeri 1 Purbalingga'], 'Madya', 'putra', 'MA001', $ids['pembina3']],
    ];
    $kStmt = $pdo->prepare('
        INSERT INTO kontingen (kegiatan_id, sekolah_id, tingkat, jenis, kode, pembina_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, "terbuka", ?)
    ');
    $kIds = [];
    foreach ($kontingens as [$sid, $tingkat, $jenis, $kode, $pid]) {
        $kStmt->execute([$kegId, $sid, $tingkat, $jenis, $kode, $pid, $now]);
        $kIds[$kode] = (int)$pdo->lastInsertId();
    }

    // Peserta
    $pesertas = [
        [$kIds['MU001'], 'MU00101', 'Nadia Putri Ramadhani', '2015-04-12', '08131110001'],
        [$kIds['MU001'], 'MU00102', 'Rafka Aditya Pratama', '2014-11-03', ''],
        [$kIds['MU001'], 'MU00103', 'Aisyah Nur Hidayah', '2015-08-21', ''],
        [$kIds['MU001'], 'MU00104', 'Bagas Saputra', '2014-05-19', ''],
        [$kIds['MU002'], 'MU00201', 'Zahra Khairunnisa', '2015-09-14', ''],
        [$kIds['MU002'], 'MU00202', 'Kirana Salsabila', '2015-01-27', ''],
        [$kIds['MU002'], 'MU00203', 'Melati Kusuma', '2014-10-08', ''],
        [$kIds['MA001'], 'MA00101', 'Dimas Prasetyo', '2012-03-17', '08561112233'],
        [$kIds['MA001'], 'MA00102', 'Fajar Nugroho', '2012-07-02', ''],
        [$kIds['MA001'], 'MA00103', 'Gilang Ramadhan', '2013-02-11', ''],
    ];
    $pStmt = $pdo->prepare('
        INSERT INTO peserta (kontingen_id, kegiatan_id, kode_peserta, nama, tanggal_lahir, kontak, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ');
    $pesertaIds = [];
    foreach ($pesertas as [$kid, $kode, $nama, $tgl, $kontak]) {
        $pStmt->execute([$kid, $kegId, $kode, $nama, $tgl, $kontak, $now]);
        $pesertaIds[$kode] = (int)$pdo->lastInsertId();
    }

    // Pos + Rubrik + Penugasan Juri
    $posConfigs = [
        [
            'nama' => 'Pertolongan Pertama',
            'urutan_tiebreaker' => 1,
            'jumlah_juri' => 2,
            'cara_gabung' => 'rata_rata',
            'pakai_timer' => 1,
            'pakai_bidak' => 0,
            'juris' => [$ids['juri1'], $ids['juri2']],
            'rubriks' => [
                ['Tes Tertulis Kepalangmerahan & PP', 'Teori', 30, 1],
                ['Penilaian Dini & Pemeriksaan Fisik', 'Praktik', 25, 2],
                ['Penanganan Luka & Pembidaian', 'Praktik', 30, 3],
                ['Kerapian, Kerjasama & Komunikasi', 'Praktik', 15, 4],
            ],
        ],
        [
            'nama' => 'Pasang Bongkar Tandu',
            'urutan_tiebreaker' => 2,
            'jumlah_juri' => 1,
            'cara_gabung' => 'jumlah',
            'pakai_timer' => 1,
            'pakai_bidak' => 1,
            'juris' => [$ids['juri3']],
            'rubriks' => [
                ['Ketepatan Simpul & Ikatan', 'Praktik', 40, 1],
                ['Kekuatan & Keseimbangan Tandu', 'Praktik', 40, 2],
                ['Keamanan Evakuasi Korban', 'Praktik', 20, 3],
            ],
        ],
        [
            'nama' => 'Kesehatan & Kebersihan Remaja',
            'urutan_tiebreaker' => 3,
            'jumlah_juri' => 1,
            'cara_gabung' => 'rata_rata',
            'pakai_timer' => 0,
            'pakai_bidak' => 0,
            'juris' => [$ids['juri3']],
            'rubriks' => [
                ['Penguasaan Materi Kesehatan', 'Teori', 40, 1],
                ['Penyampaian & Media Edukasi', 'Praktik', 40, 2],
                ['Tanya Jawab & Sikap', 'Praktik', 20, 3],
            ],
        ],
    ];

    $posStmt = $pdo->prepare('
        INSERT INTO pos (kegiatan_id, nama, urutan_tiebreaker, jumlah_juri, cara_gabung, pakai_timer, pakai_bidak, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ');
    $rubStmt = $pdo->prepare('
        INSERT INTO rubrik (pos_id, nama, komponen, nilai_maksimal, urutan)
        VALUES (?, ?, ?, ?, ?)
    ');
    $assignStmt = $pdo->prepare('
        INSERT INTO penugasan_juri (pos_id, juri_id, created_at)
        VALUES (?, ?, ?)
    ');

    $posIds = [];
    $rubIdsByPos = [];
    foreach ($posConfigs as $cfg) {
        $posStmt->execute([
            $kegId,
            $cfg['nama'],
            $cfg['urutan_tiebreaker'],
            $cfg['jumlah_juri'],
            $cfg['cara_gabung'],
            $cfg['pakai_timer'],
            $cfg['pakai_bidak'],
            $now,
        ]);
        $pid = (int)$pdo->lastInsertId();
        $posIds[$cfg['nama']] = $pid;
        $rubIdsByPos[$pid] = [];

        foreach ($cfg['juris'] as $jid) {
            $assignStmt->execute([$pid, $jid, $now]);
        }
        foreach ($cfg['rubriks'] as [$rNama, $komp, $maks, $urutan]) {
            $rubStmt->execute([$pid, $rNama, $komp, $maks, $urutan]);
            $rubIdsByPos[$pid][] = (int)$pdo->lastInsertId();
        }
    }

    // Seed sample completed scores so TV & Laporan look alive right away
    $seedSession = function (string $uuid, int $kontingenId, int $posId, int $juriId, array $scores, int $timer, float $bidak, array $attendees) use ($pdo, $kegId, $rubIdsByPos, $now) {
        $pdo->prepare("
            INSERT INTO sesi_penilaian (client_session_uuid, kegiatan_id, kontingen_id, pos_id, juri_id, status, timer_detik, bidak, waktu_mulai, waktu_selesai)
            VALUES (?, ?, ?, ?, ?, 'selesai', ?, ?, ?, ?)
        ")->execute([$uuid, $kegId, $kontingenId, $posId, $juriId, $timer, $bidak, $now, $now]);
        $sesiId = (int)$pdo->lastInsertId();

        $khStmt = $pdo->prepare('INSERT INTO kehadiran (sesi_id, peserta_id, peran_di_pos) VALUES (?, ?, ?)');
        foreach ($attendees as [$pesId, $role]) {
            $khStmt->execute([$sesiId, $pesId, $role]);
        }

        $njStmt = $pdo->prepare('
            INSERT INTO nilai_juri (uid_unik, sesi_id, juri_id, rubrik_id, nilai, timer, bidak, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ');
        foreach ($rubIdsByPos[$posId] as $idx => $rubId) {
            $njStmt->execute([
                $uuid . '-r' . $rubId,
                $sesiId,
                $juriId,
                $rubId,
                $scores[$idx] ?? 0,
                $timer,
                $bidak,
                $now,
            ]);
        }

        recalculate_nilai_akhir_pos($pdo, $kontingenId, $posId);
    };

    // MU001 scored at Pertolongan Pertama by juri1 and juri2
    $ppId = $posIds['Pertolongan Pertama'];
    $tanduId = $posIds['Pasang Bongkar Tandu'];
    $kkrId = $posIds['Kesehatan & Kebersihan Remaja'];

    $seedSession('seed-mu001-pp-j1', $kIds['MU001'], $ppId, $ids['juri1'], [27, 23, 28, 14], 245, 0, [
        [$pesertaIds['MU00101'], 'Pemimpin'],
        [$pesertaIds['MU00102'], 'Pelaku'],
        [$pesertaIds['MU00103'], 'Narator'],
    ]);
    $seedSession('seed-mu001-pp-j2', $kIds['MU001'], $ppId, $ids['juri2'], [27, 22, 27, 13], 245, 0, [
        [$pesertaIds['MU00101'], 'Pemimpin'],
        [$pesertaIds['MU00102'], 'Pelaku'],
        [$pesertaIds['MU00103'], 'Narator'],
    ]);

    // MU002 scored at Pasang Bongkar Tandu by juri3
    $seedSession('seed-mu002-tandu-j3', $kIds['MU002'], $tanduId, $ids['juri3'], [36, 35, 18], 198, 12, [
        [$pesertaIds['MU00201'], 'Pemimpin'],
        [$pesertaIds['MU00202'], 'Pelaku'],
    ]);

    // MU002 currently live ("berjalan") at Pertolongan Pertama so TV banner demonstrates active state
    $pdo->prepare("
        INSERT INTO sesi_penilaian (client_session_uuid, kegiatan_id, kontingen_id, pos_id, juri_id, status, timer_detik, bidak, waktu_mulai)
        VALUES ('seed-mu002-pp-live', ?, ?, ?, ?, 'berjalan', 0, 0, ?)
    ")->execute([$kegId, $kIds['MU002'], $ppId, $ids['juri1'], $now]);

    // MU001 scored at KKR
    $seedSession('seed-mu001-kkr-j3', $kIds['MU001'], $kkrId, $ids['juri3'], [35, 36, 17], 0, 0, [
        [$pesertaIds['MU00104'], 'Penyuluh'],
    ]);

    write_log($pdo, ['id' => $ids['admin'], 'nama' => 'Admin PMI Purbalingga', 'peran' => 'admin'], 'inisialisasi', 'Data awal demo Jumbara PMR berhasil dibuat.', 'kegiatan:' . $kegId);
}
