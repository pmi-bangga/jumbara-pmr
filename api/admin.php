<?php
declare(strict_types=1);

function compute_standings_and_reports(PDO $pdo, int $kegiatanId): array {
    $posStmt = $pdo->prepare('SELECT * FROM pos WHERE kegiatan_id = ? ORDER BY id ASC');
    $posStmt->execute([$kegiatanId]);
    $posList = $posStmt->fetchAll();

    $posTieOrdered = $posList;
    usort($posTieOrdered, fn($a, $b) => ((int)$a['urutan_tiebreaker']) <=> ((int)$b['urutan_tiebreaker']) ?: ((int)$a['id']) <=> ((int)$b['id']));

    $kStmt = $pdo->prepare('
        SELECT k.id, k.kode, k.tingkat, k.jenis, k.status, s.nama AS sekolah_nama,
               (SELECT COUNT(*) FROM peserta p WHERE p.kontingen_id = k.id) AS jumlah_peserta
        FROM kontingen k
        JOIN sekolah s ON s.id = k.sekolah_id
        WHERE k.kegiatan_id = ?
        ORDER BY k.kode ASC
    ');
    $kStmt->execute([$kegiatanId]);
    $kontingens = $kStmt->fetchAll();

    $napStmt = $pdo->prepare('SELECT * FROM nilai_akhir_pos WHERE kegiatan_id = ?');
    $napStmt->execute([$kegiatanId]);
    $napMap = [];
    foreach ($napStmt->fetchAll() as $n) {
        $napMap[(int)$n['kontingen_id']][(int)$n['pos_id']] = $n;
    }

    $timerPosIds = [];
    $bidakPosIds = [];
    foreach ($posList as $p) {
        if ((int)$p['pakai_timer'] === 1) $timerPosIds[] = (int)$p['id'];
        if ((int)$p['pakai_bidak'] === 1) $bidakPosIds[] = (int)$p['id'];
    }

    $standings = [];
    foreach ($kontingens as $k) {
        $kid = (int)$k['id'];
        $totalNilai = 0.0;
        $totalTimer = 0;
        $totalBidak = 0.0;
        $posScores = [];

        foreach ($posList as $p) {
            $pid = (int)$p['id'];
            $entry = $napMap[$kid][$pid] ?? null;
            if ($entry) {
                $val = (float)$entry['nilai_akhir'];
                $totalNilai += $val;
                if (in_array($pid, $timerPosIds, true)) {
                    $totalTimer += (int)$entry['total_timer'];
                }
                if (in_array($pid, $bidakPosIds, true)) {
                    $totalBidak += (float)$entry['bidak'];
                }
                $posScores[$pid] = [
                    'nilai_akhir' => $val,
                    'total_timer' => (int)$entry['total_timer'],
                    'bidak' => (float)$entry['bidak'],
                    'has_revisi' => (bool)$entry['has_revisi'],
                ];
            } else {
                $posScores[$pid] = null;
            }
        }

        $standings[] = [
            'kontingen_id' => $kid,
            'kode' => $k['kode'],
            'sekolah_nama' => $k['sekolah_nama'],
            'tingkat' => $k['tingkat'],
            'jenis' => $k['jenis'],
            'jumlah_peserta' => (int)$k['jumlah_peserta'],
            'total_nilai' => round($totalNilai, 2),
            'total_timer' => $totalTimer,
            'total_bidak' => round($totalBidak, 2),
            'pos_scores' => $posScores,
        ];
    }

    // Dynamic Juara Umum sort:
    // 1. Total nilai (DESC)
    // 2. Total timer on timer-enabled pos (ASC - faster is better; 0 if no timer pos scored placed after timed if needed? Use standard ASC when >0, or total_timer ASC)
    // 3. Bidak (DESC)
    // 4. Pos tiebreaker order (DESC)
    $ranked = $standings;
    usort($ranked, function ($a, $b) use ($posTieOrdered) {
        if ($b['total_nilai'] !== $a['total_nilai']) {
            return $b['total_nilai'] <=> $a['total_nilai'];
        }
        if ($a['total_timer'] !== $b['total_timer']) {
            return $a['total_timer'] <=> $b['total_timer'];
        }
        if ($b['total_bidak'] !== $a['total_bidak']) {
            return $b['total_bidak'] <=> $a['total_bidak'];
        }
        foreach ($posTieOrdered as $pos) {
            $pid = (int)$pos['id'];
            $va = $a['pos_scores'][$pid]['nilai_akhir'] ?? 0.0;
            $vb = $b['pos_scores'][$pid]['nilai_akhir'] ?? 0.0;
            if ($vb !== $va) {
                return $vb <=> $va;
            }
        }
        return strcmp($a['kode'], $b['kode']);
    });

    foreach ($ranked as $i => &$row) {
        $row['peringkat'] = $i + 1;
    }
    unset($row);

    // Peserta paling aktif: youngest age (latest tanggal_lahir) among participants with recorded attendance
    $youngStmt = $pdo->prepare("
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
    ");
    $youngStmt->execute([$kegiatanId]);
    $pesertaPalingAktif = $youngStmt->fetchAll();

    return [
        'pos_list' => $posList,
        'standings_by_kode' => $standings,
        'juara_umum' => $ranked,
        'peserta_paling_aktif' => $pesertaPalingAktif,
    ];
}

function handle_admin_action(PDO $pdo, array $user, string $action, array $body): void {
    if ($action === 'admin_bootstrap') {
        $kegiatanList = $pdo->query('SELECT * FROM kegiatan ORDER BY tahun DESC')->fetchAll();
        foreach ($kegiatanList as &$kg) {
            $kg['id'] = (int)$kg['id'];
            $kg['tahun'] = (int)$kg['tahun'];
            $kg['is_active'] = (bool)$kg['is_active'];
            $kg['tingkat_aktif'] = json_decode($kg['tingkat_aktif'], true) ?: [];
        }
        unset($kg);

        $active = get_active_kegiatan($pdo);
        $kegId = (int)($_GET['kegiatan_id'] ?? ($active['id'] ?? 0));

        $sekolah = $pdo->query('SELECT * FROM sekolah ORDER BY nama ASC')->fetchAll();
        $akun = $pdo->query('SELECT id, username, nama, peran, no_wa, wajib_ganti_password, created_at FROM akun ORDER BY peran ASC, nama ASC')->fetchAll();

        $posList = [];
        $kontingenList = [];
        $pesertaList = [];
        $koreksiList = [];
        $reports = null;

        if ($kegId > 0) {
            $posRows = $pdo->prepare('SELECT * FROM pos WHERE kegiatan_id = ? ORDER BY id ASC');
            $posRows->execute([$kegId]);
            $posList = $posRows->fetchAll();

            $rStmt = $pdo->prepare('SELECT * FROM rubrik WHERE pos_id = ? ORDER BY urutan ASC, id ASC');
            $pjStmt = $pdo->prepare('
                SELECT a.id, a.username, a.nama, a.no_wa
                FROM penugasan_juri pj
                JOIN akun a ON a.id = pj.juri_id
                WHERE pj.pos_id = ?
                ORDER BY a.nama ASC
            ');

            foreach ($posList as &$p) {
                $p['id'] = (int)$p['id'];
                $p['jumlah_juri'] = (int)$p['jumlah_juri'];
                $p['urutan_tiebreaker'] = (int)$p['urutan_tiebreaker'];
                $p['pakai_timer'] = (bool)$p['pakai_timer'];
                $p['pakai_bidak'] = (bool)$p['pakai_bidak'];
                $rStmt->execute([$p['id']]);
                $p['rubriks'] = $rStmt->fetchAll();
                $pjStmt->execute([$p['id']]);
                $p['juri_ditugaskan'] = $pjStmt->fetchAll();
                $p['juri_lengkap'] = count($p['juri_ditugaskan']) >= $p['jumlah_juri'];
            }
            unset($p);

            $kStmt = $pdo->prepare('
                SELECT k.*, s.nama AS sekolah_nama, a.nama AS pembina_nama, a.no_wa AS pembina_wa
                FROM kontingen k
                JOIN sekolah s ON s.id = k.sekolah_id
                JOIN akun a ON a.id = k.pembina_id
                WHERE k.kegiatan_id = ?
                ORDER BY k.kode ASC
            ');
            $kStmt->execute([$kegId]);
            $kontingenList = $kStmt->fetchAll();

            $pStmt = $pdo->prepare('
                SELECT p.*, k.kode AS kontingen_kode, k.tingkat, k.jenis, s.nama AS sekolah_nama
                FROM peserta p
                JOIN kontingen k ON k.id = p.kontingen_id
                JOIN sekolah s ON s.id = k.sekolah_id
                WHERE p.kegiatan_id = ?
                ORDER BY p.kode_peserta ASC
            ');
            $pStmt->execute([$kegId]);
            $pesertaList = $pStmt->fetchAll();

            $krStmt = $pdo->prepare('
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
                ORDER BY CASE WHEN kr.status = "diajukan" THEN 0 ELSE 1 END, kr.id DESC
            ');
            $krStmt->execute([$kegId]);
            $koreksiList = $krStmt->fetchAll();

            $reports = compute_standings_and_reports($pdo, $kegId);
        }

        json_response([
            'ok' => true,
            'kegiatan_active' => $active,
            'kegiatan_list' => $kegiatanList,
            'selected_kegiatan_id' => $kegId,
            'sekolah' => $sekolah,
            'akun' => $akun,
            'pos_list' => $posList,
            'kontingen_list' => $kontingenList,
            'peserta_list' => $pesertaList,
            'koreksi_list' => $koreksiList,
            'reports' => $reports,
        ]);
    }

    if ($action === 'admin_save_kegiatan') {
        $id = (int)($body['id'] ?? 0);
        $tahun = (int)($body['tahun'] ?? 0);
        $nama = trim((string)($body['nama'] ?? ''));
        $tingkatAktif = $body['tingkat_aktif'] ?? [];
        $tanggal = trim((string)($body['tanggal'] ?? ''));
        $hariKunci = trim((string)($body['hari_kunci'] ?? ''));
        $setActive = !empty($body['is_active']);

        if ($tahun < 2024 || $nama === '' || !is_array($tingkatAktif) || count($tingkatAktif) === 0 || $tanggal === '' || $hariKunci === '') {
            json_error('Tahun, nama kegiatan, minimal 1 tingkat aktif, tanggal, dan hari kunci wajib diisi.', 400);
        }

        $validTingkat = array_values(array_intersect(['Mula', 'Madya', 'Wira'], $tingkatAktif));
        if (count($validTingkat) === 0) {
            json_error('Tingkat aktif tidak valid.', 400);
        }

        $pdo->beginTransaction();
        try {
            if ($setActive) {
                $pdo->exec('UPDATE kegiatan SET is_active = 0');
            }
            if ($id > 0) {
                $pdo->prepare('UPDATE kegiatan SET tahun = ?, nama = ?, tingkat_aktif = ?, tanggal = ?, hari_kunci = ?, is_active = ? WHERE id = ?')
                    ->execute([$tahun, $nama, json_encode($validTingkat), $tanggal, $hariKunci, $setActive ? 1 : 0, $id]);
                write_log($pdo, $user, 'ubah_kegiatan', "Kegiatan $nama ($tahun) diperbarui.", "kegiatan:$id");
            } else {
                $pdo->prepare('INSERT INTO kegiatan (tahun, nama, tingkat_aktif, tanggal, hari_kunci, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                    ->execute([$tahun, $nama, json_encode($validTingkat), $tanggal, $hariKunci, $setActive ? 1 : 0, now_iso()]);
                $id = (int)$pdo->lastInsertId();
                write_log($pdo, $user, 'buat_kegiatan', "Kegiatan baru $nama ($tahun) dibuat.", "kegiatan:$id");
            }
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            json_error('Gagal menyimpan kegiatan (pastikan tahun belum dipakai kegiatan lain).', 400);
        }
        json_response(['ok' => true, 'id' => $id]);
    }

    if ($action === 'admin_import_sekolah') {
        $csvText = trim((string)($body['csv_text'] ?? ''));
        if ($csvText === '') {
            json_error('Isi CSV sekolah kosong.', 400);
        }
        $lines = preg_split('/\r\n|\r|\n/', $csvText);
        $added = 0;
        $stmt = $pdo->prepare('INSERT OR IGNORE INTO sekolah (nama) VALUES (?)');
        foreach ($lines as $idx => $line) {
            $cols = str_getcsv($line);
            $name = trim((string)($cols[0] ?? ''));
            if ($name === '' || ($idx === 0 && preg_match('/^(nama|sekolah|nama_sekolah)$/i', $name))) {
                continue;
            }
            $stmt->execute([$name]);
            if ($stmt->rowCount() > 0) $added++;
        }
        write_log($pdo, $user, 'impor_sekolah', "Impor CSV sekolah: $added sekolah baru ditambahkan.");
        json_response(['ok' => true, 'added' => $added]);
    }

    if ($action === 'admin_save_pos') {
        $id = (int)($body['id'] ?? 0);
        $kegiatanId = (int)($body['kegiatan_id'] ?? 0);
        $nama = trim((string)($body['nama'] ?? ''));
        $urutanTie = max(1, (int)($body['urutan_tiebreaker'] ?? 1));
        $jumlahJuri = min(3, max(1, (int)($body['jumlah_juri'] ?? 1)));
        $caraGabung = ($body['cara_gabung'] ?? 'rata_rata') === 'jumlah' ? 'jumlah' : 'rata_rata';
        $pakaiTimer = !empty($body['pakai_timer']) ? 1 : 0;
        $pakaiBidak = !empty($body['pakai_bidak']) ? 1 : 0;
        $rubriks = $body['rubriks'] ?? [];
        $juriIds = $body['juri_ids'] ?? [];

        if ($kegiatanId <= 0 || $nama === '' || !is_array($rubriks) || count($rubriks) === 0) {
            json_error('Nama pos, kegiatan, dan minimal 1 rubrik wajib diisi.', 400);
        }

        $pdo->beginTransaction();
        try {
            if ($id > 0) {
                $pdo->prepare('
                    UPDATE pos SET nama = ?, urutan_tiebreaker = ?, jumlah_juri = ?, cara_gabung = ?, pakai_timer = ?, pakai_bidak = ?
                    WHERE id = ? AND kegiatan_id = ?
                ')->execute([$nama, $urutanTie, $jumlahJuri, $caraGabung, $pakaiTimer, $pakaiBidak, $id, $kegiatanId]);

                // Update existing rubrics or insert new ones cleanly (preserve rubrik IDs if already scored)
                $existingRubIds = $pdo->prepare('SELECT id FROM rubrik WHERE pos_id = ?');
                $existingRubIds->execute([$id]);
                $keepIds = [];
                foreach ($rubriks as $idx => $r) {
                    $rid = (int)($r['id'] ?? 0);
                    $rNama = trim((string)($r['nama'] ?? ''));
                    $komp = in_array(($r['komponen'] ?? 'Umum'), ['Umum', 'Teori', 'Praktik'], true) ? $r['komponen'] : 'Umum';
                    $maks = max(1, (float)($r['nilai_maksimal'] ?? 10));
                    if ($rNama === '') continue;
                    if ($rid > 0) {
                        $pdo->prepare('UPDATE rubrik SET nama = ?, komponen = ?, nilai_maksimal = ?, urutan = ? WHERE id = ? AND pos_id = ?')
                            ->execute([$rNama, $komp, $maks, $idx + 1, $rid, $id]);
                        $keepIds[] = $rid;
                    } else {
                        $pdo->prepare('INSERT INTO rubrik (pos_id, nama, komponen, nilai_maksimal, urutan) VALUES (?, ?, ?, ?, ?)')
                            ->execute([$id, $rNama, $komp, $maks, $idx + 1]);
                        $keepIds[] = (int)$pdo->lastInsertId();
                    }
                }
                if (count($keepIds) > 0) {
                    $ph = implode(',', array_fill(0, count($keepIds), '?'));
                    $pdo->prepare("DELETE FROM rubrik WHERE pos_id = ? AND id NOT IN ($ph)")->execute(array_merge([$id], $keepIds));
                }
            } else {
                $pdo->prepare('
                    INSERT INTO pos (kegiatan_id, nama, urutan_tiebreaker, jumlah_juri, cara_gabung, pakai_timer, pakai_bidak, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ')->execute([$kegiatanId, $nama, $urutanTie, $jumlahJuri, $caraGabung, $pakaiTimer, $pakaiBidak, now_iso()]);
                $id = (int)$pdo->lastInsertId();

                $rIns = $pdo->prepare('INSERT INTO rubrik (pos_id, nama, komponen, nilai_maksimal, urutan) VALUES (?, ?, ?, ?, ?)');
                foreach ($rubriks as $idx => $r) {
                    $rNama = trim((string)($r['nama'] ?? ''));
                    $komp = in_array(($r['komponen'] ?? 'Umum'), ['Umum', 'Teori', 'Praktik'], true) ? $r['komponen'] : 'Umum';
                    $maks = max(1, (float)($r['nilai_maksimal'] ?? 10));
                    if ($rNama === '') continue;
                    $rIns->execute([$id, $rNama, $komp, $maks, $idx + 1]);
                }
            }

            // Replace judge assignments
            $pdo->prepare('DELETE FROM penugasan_juri WHERE pos_id = ?')->execute([$id]);
            $pjIns = $pdo->prepare('INSERT OR IGNORE INTO penugasan_juri (pos_id, juri_id, created_at) VALUES (?, ?, ?)');
            foreach ($juriIds as $jid) {
                $jidInt = (int)$jid;
                if ($jidInt > 0) $pjIns->execute([$id, $jidInt, now_iso()]);
            }

            write_log($pdo, $user, 'pengaturan_pos', "Pengaturan pos \"$nama\" disimpan (juri: $jumlahJuri, gabung: $caraGabung).", "pos:$id", '', $nama);
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            json_error('Gagal menyimpan pengaturan pos: ' . $e->getMessage(), 400);
        }
        json_response(['ok' => true, 'id' => $id]);
    }

    if ($action === 'admin_create_juri') {
        $nama = trim((string)($body['nama'] ?? ''));
        $username = strtolower(trim((string)($body['username'] ?? '')));
        $wa = normalize_wa((string)($body['no_wa'] ?? ''));
        $password = (string)($body['password'] ?? '');

        if ($nama === '' || $username === '' || $wa === '' || strlen($password) < 6) {
            json_error('Nama, username, nomor WhatsApp wajib, dan password (minimal 6 karakter) wajib diisi.', 400);
        }

        $exists = $pdo->prepare('SELECT id FROM akun WHERE username = ?');
        $exists->execute([$username]);
        if ($exists->fetch()) {
            json_error('Username sudah digunakan.', 400);
        }

        $pdo->prepare("
            INSERT INTO akun (username, nama, peran, no_wa, password_hash, wajib_ganti_password, created_at)
            VALUES (?, ?, 'juri', ?, ?, 1, ?)
        ")->execute([$username, $nama, $wa, password_hash($password, PASSWORD_DEFAULT), now_iso()]);
        $id = (int)$pdo->lastInsertId();

        write_log($pdo, $user, 'buat_juri', "Akun juri baru dibuat: $nama (@$username, WA: $wa).", "akun:$id");
        json_response(['ok' => true, 'id' => $id]);
    }

    if ($action === 'admin_reset_account') {
        $targetId = (int)($body['akun_id'] ?? 0);
        $stmt = $pdo->prepare("SELECT * FROM akun WHERE id = ? AND peran IN ('pembina', 'juri')");
        $stmt->execute([$targetId]);
        $target = $stmt->fetch();
        if (!$target) {
            json_error('Hanya akun pembina atau juri yang dapat direset.', 404);
        }

        $tempPass = generate_temp_password(8);
        $pdo->prepare('UPDATE akun SET password_hash = ?, wajib_ganti_password = 1 WHERE id = ?')
            ->execute([password_hash($tempPass, PASSWORD_DEFAULT), $targetId]);

        $waMessage = rawurlencode("Halo {$target['nama']}, password sementara akun Jumbara PMR Anda ({$target['username']}) adalah: $tempPass . Wajib diganti saat login pertama.");
        $waUrl = "https://wa.me/{$target['no_wa']}?text=$waMessage";

        write_log($pdo, $user, 'reset_akun', "Reset akun {$target['peran']} {$target['nama']} (@{$target['username']}). Password sementara dibuat untuk WA {$target['no_wa']}.", "akun:$targetId");

        json_response([
            'ok' => true,
            'username' => $target['username'],
            'nama' => $target['nama'],
            'no_wa' => $target['no_wa'],
            'temp_password' => $tempPass,
            'wa_url' => $waUrl,
        ]);
    }

    if ($action === 'admin_update_peserta') {
        $pesertaId = (int)($body['id'] ?? 0);
        $nama = trim((string)($body['nama'] ?? ''));
        $tglLahir = trim((string)($body['tanggal_lahir'] ?? ''));
        $kontak = trim((string)($body['kontak'] ?? ''));
        $alasan = trim((string)($body['alasan'] ?? ''));

        if ($pesertaId <= 0 || $nama === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $tglLahir) || $alasan === '') {
            json_error('Data peserta dan alasan perubahan wajib diisi.', 400);
        }

        $pStmt = $pdo->prepare('SELECT p.*, k.kode AS kontingen_kode FROM peserta p JOIN kontingen k ON k.id = p.kontingen_id WHERE p.id = ?');
        $pStmt->execute([$pesertaId]);
        $existing = $pStmt->fetch();
        if (!$existing) {
            json_error('Peserta tidak ditemukan.', 404);
        }

        $pdo->prepare('UPDATE peserta SET nama = ?, tanggal_lahir = ?, kontak = ? WHERE id = ?')
            ->execute([$nama, $tglLahir, $kontak, $pesertaId]);

        write_log(
            $pdo,
            $user,
            'ubah_data_admin',
            "Admin mengubah peserta {$existing['kode_peserta']} ({$existing['nama']} -> $nama). Alasan: $alasan",
            "peserta:$pesertaId",
            $existing['kontingen_kode']
        );
        json_response(['ok' => true]);
    }

    if ($action === 'admin_toggle_kontingen_lock') {
        $kid = (int)($body['kontingen_id'] ?? 0);
        $status = ($body['status'] ?? '') === 'terkunci' ? 'terkunci' : 'terbuka';
        $alasan = trim((string)($body['alasan'] ?? 'Pengaturan status kunci oleh admin'));

        $kStmt = $pdo->prepare('SELECT * FROM kontingen WHERE id = ?');
        $kStmt->execute([$kid]);
        $kont = $kStmt->fetch();
        if (!$kont) json_error('Kontingen tidak ditemukan.', 404);

        $pdo->prepare('UPDATE kontingen SET status = ? WHERE id = ?')->execute([$status, $kid]);
        write_log($pdo, $user, 'ubah_kunci_kontingen', "Status kontingen {$kont['kode']} diubah menjadi $status. Alasan: $alasan", "kontingen:$kid", $kont['kode']);
        json_response(['ok' => true]);
    }

    if ($action === 'admin_decide_correction') {
        $koreksiId = (int)($body['koreksi_id'] ?? 0);
        $decision = ($body['decision'] ?? '') === 'disetujui' ? 'disetujui' : 'ditolak';
        $catatan = trim((string)($body['catatan_admin'] ?? ''));

        $krStmt = $pdo->prepare("
            SELECT kr.*, sp.kontingen_id, sp.pos_id, sp.juri_id, k.kode AS kontingen_kode, p.nama AS pos_nama
            FROM koreksi kr
            JOIN sesi_penilaian sp ON sp.id = kr.sesi_id
            JOIN kontingen k ON k.id = sp.kontingen_id
            JOIN pos p ON p.id = sp.pos_id
            WHERE kr.id = ? AND kr.status = 'diajukan'
        ");
        $krStmt->execute([$koreksiId]);
        $kr = $krStmt->fetch();
        if (!$kr) {
            json_error('Pengajuan koreksi tidak ditemukan atau sudah diproses.', 404);
        }

        $pdo->beginTransaction();
        try {
            $now = now_iso();
            $pdo->prepare('UPDATE koreksi SET status = ?, admin_penyetuju_id = ?, catatan_admin = ?, waktu_keputusan = ? WHERE id = ?')
                ->execute([$decision, $user['id'], $catatan, $now, $koreksiId]);

            if ($decision === 'disetujui') {
                $detailBaru = json_decode($kr['detail_baru'], true);
                $newTimer = (int)($detailBaru['timer_detik'] ?? 0);
                $newBidak = (float)($detailBaru['bidak'] ?? 0);

                $pdo->prepare('UPDATE sesi_penilaian SET timer_detik = ?, bidak = ? WHERE id = ?')
                    ->execute([$newTimer, $newBidak, $kr['sesi_id']]);

                $updNilai = $pdo->prepare('UPDATE nilai_juri SET nilai = ?, timer = ?, bidak = ? WHERE sesi_id = ? AND rubrik_id = ?');
                foreach (($detailBaru['scores'] ?? []) as $sc) {
                    $updNilai->execute([(float)$sc['nilai'], $newTimer, $newBidak, $kr['sesi_id'], (int)$sc['rubrik_id']]);
                }

                recalculate_nilai_akhir_pos($pdo, (int)$kr['kontingen_id'], (int)$kr['pos_id']);
            }

            write_log(
                $pdo,
                $user,
                'keputusan_koreksi',
                "Koreksi #$koreksiId ({$kr['kontingen_kode']} - {$kr['pos_nama']}) $decision ({$kr['nilai_lama']} -> {$kr['nilai_baru']}). Alasan juri: {$kr['alasan']}",
                "koreksi:$koreksiId",
                $kr['kontingen_kode'],
                $kr['pos_nama']
            );
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
        json_response(['ok' => true]);
    }

    if ($action === 'admin_logs') {
        $where = ['1=1'];
        $params = [];

        if (!empty($_GET['jenis'])) {
            $where[] = 'jenis_aktivitas = ?';
            $params[] = trim((string)$_GET['jenis']);
        }
        if (!empty($_GET['kontingen'])) {
            $where[] = 'UPPER(kontingen_kode) LIKE ?';
            $params[] = '%' . strtoupper(trim((string)$_GET['kontingen'])) . '%';
        }
        if (!empty($_GET['pos'])) {
            $where[] = 'LOWER(pos_nama) LIKE ?';
            $params[] = '%' . strtolower(trim((string)$_GET['pos'])) . '%';
        }
        if (!empty($_GET['pelaku'])) {
            $where[] = 'LOWER(pelaku_nama) LIKE ?';
            $params[] = '%' . strtolower(trim((string)$_GET['pelaku'])) . '%';
        }
        if (!empty($_GET['q'])) {
            $q = '%' . strtolower(trim((string)$_GET['q'])) . '%';
            $where[] = '(LOWER(detail) LIKE ? OR LOWER(pelaku_nama) LIKE ? OR LOWER(kontingen_kode) LIKE ? OR LOWER(pos_nama) LIKE ?)';
            array_push($params, $q, $q, $q, $q);
        }

        $sql = 'SELECT * FROM log WHERE ' . implode(' AND ', $where) . ' ORDER BY id DESC LIMIT 300';
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $types = $pdo->query('SELECT DISTINCT jenis_aktivitas FROM log ORDER BY jenis_aktivitas ASC')->fetchAll(PDO::FETCH_COLUMN);

        json_response(['ok' => true, 'logs' => $stmt->fetchAll(), 'activity_types' => $types]);
    }

    if ($action === 'admin_detailed_report') {
        $kegId = (int)($_GET['kegiatan_id'] ?? 0);
        if ($kegId <= 0) {
            $act = get_active_kegiatan($pdo);
            $kegId = $act ? (int)$act['id'] : 0;
        }
        if ($kegId <= 0) json_error('Kegiatan tidak ditemukan.', 404);

        $konts = $pdo->prepare('
            SELECT k.id, k.kode, k.tingkat, k.jenis, s.nama AS sekolah_nama
            FROM kontingen k JOIN sekolah s ON s.id = k.sekolah_id
            WHERE k.kegiatan_id = ? ORDER BY k.kode ASC
        ');
        $konts->execute([$kegId]);
        $kontList = $konts->fetchAll();

        $posRows = $pdo->prepare('SELECT id FROM pos WHERE kegiatan_id = ? ORDER BY id ASC');
        $posRows->execute([$kegId]);
        $posIds = $posRows->fetchAll(PDO::FETCH_COLUMN);

        $receipts = [];
        foreach ($kontList as $k) {
            foreach ($posIds as $pid) {
                $r = get_receipt_payload($pdo, $kegId, $k['kode'], (int)$pid);
                if ($r && count($r['juri_breakdown']) > 0) {
                    $receipts[] = $r;
                }
            }
        }

        json_response([
            'ok' => true,
            'receipts' => $receipts,
            'summary' => compute_standings_and_reports($pdo, $kegId),
        ]);
    }

    json_error('Aksi admin tidak dikenal.', 404);
}
