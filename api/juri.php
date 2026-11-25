<?php
declare(strict_types=1);

function assert_judge_assigned(PDO $pdo, int $posId, int $juriId): array {
    $stmt = $pdo->prepare('
        SELECT p.*
        FROM pos p
        JOIN penugasan_juri pj ON pj.pos_id = p.id
        WHERE p.id = ? AND pj.juri_id = ?
    ');
    $stmt->execute([$posId, $juriId]);
    $pos = $stmt->fetch();
    if (!$pos) {
        json_error('Anda tidak ditugaskan pada pos ini.', 403);
    }
    return $pos;
}

function handle_juri_action(PDO $pdo, array $user, string $action, array $body): void {
    $kegiatan = get_active_kegiatan($pdo);
    if (!$kegiatan) {
        json_error('Belum ada kegiatan aktif.', 400);
    }

    if ($action === 'juri_bootstrap') {
        // Assigned pos + rubrics + offline peserta lookup + session history
        $posStmt = $pdo->prepare('
            SELECT p.*
            FROM pos p
            JOIN penugasan_juri pj ON pj.pos_id = p.id
            WHERE p.kegiatan_id = ? AND pj.juri_id = ?
            ORDER BY p.id ASC
        ');
        $posStmt->execute([$kegiatan['id'], $user['id']]);
        $posList = $posStmt->fetchAll();

        $rubrikStmt = $pdo->prepare('SELECT * FROM rubrik WHERE pos_id = ? ORDER BY urutan ASC, id ASC');
        foreach ($posList as &$p) {
            $p['id'] = (int)$p['id'];
            $p['jumlah_juri'] = (int)$p['jumlah_juri'];
            $p['pakai_timer'] = (bool)$p['pakai_timer'];
            $p['pakai_bidak'] = (bool)$p['pakai_bidak'];
            $rubrikStmt->execute([$p['id']]);
            $p['rubriks'] = $rubrikStmt->fetchAll();
        }
        unset($p);

        // Minimal participant cache for offline QR scanning in judge device
        $pesertaStmt = $pdo->prepare('
            SELECT p.id, p.kode_peserta, p.nama, k.id AS kontingen_id, k.kode AS kontingen_kode, k.tingkat, k.jenis, s.nama AS sekolah_nama
            FROM peserta p
            JOIN kontingen k ON k.id = p.kontingen_id
            JOIN sekolah s ON s.id = k.sekolah_id
            WHERE p.kegiatan_id = ?
            ORDER BY p.kode_peserta ASC
        ');
        $pesertaStmt->execute([$kegiatan['id']]);
        $pesertaCache = $pesertaStmt->fetchAll();

        // Judge's completed sessions & pending/decided corrections
        $histStmt = $pdo->prepare("
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
        ");
        $histStmt->execute([$kegiatan['id'], $user['id']]);
        $history = $histStmt->fetchAll();

        json_response([
            'ok' => true,
            'kegiatan' => $kegiatan,
            'pos_list' => $posList,
            'peserta_cache' => $pesertaCache,
            'history' => $history,
        ]);
    }

    if ($action === 'juri_lookup_peserta') {
        $posId = (int)($_GET['pos_id'] ?? $body['pos_id'] ?? 0);
        $kode = strtoupper(trim((string)($_GET['kode'] ?? $body['kode'] ?? '')));
        assert_judge_assigned($pdo, $posId, $user['id']);

        if ($kode === '') {
            json_error('Kode peserta wajib diisi atau dipindai.', 400);
        }

        $stmt = $pdo->prepare('
            SELECT p.id, p.kode_peserta, p.nama, k.id AS kontingen_id, k.kode AS kontingen_kode, k.tingkat, k.jenis, s.nama AS sekolah_nama
            FROM peserta p
            JOIN kontingen k ON k.id = p.kontingen_id
            JOIN sekolah s ON s.id = k.sekolah_id
            WHERE p.kegiatan_id = ? AND UPPER(p.kode_peserta) = ?
            LIMIT 1
        ');
        $stmt->execute([$kegiatan['id'], $kode]);
        $row = $stmt->fetch();
        if (!$row) {
            json_error("Kode peserta \"$kode\" tidak terdaftar pada kegiatan ini.", 404);
        }

        json_response(['ok' => true, 'peserta' => $row]);
    }

    if ($action === 'juri_session_start') {
        $posId = (int)($body['pos_id'] ?? 0);
        $kontingenId = (int)($body['kontingen_id'] ?? 0);
        $uuid = trim((string)($body['client_session_uuid'] ?? ''));

        assert_judge_assigned($pdo, $posId, $user['id']);
        if ($uuid === '' || $kontingenId <= 0) {
            json_error('UUID sesi dan kontingen wajib diisi.', 400);
        }

        $kCheck = $pdo->prepare('SELECT id, kode FROM kontingen WHERE id = ? AND kegiatan_id = ?');
        $kCheck->execute([$kontingenId, $kegiatan['id']]);
        $kontingen = $kCheck->fetch();
        if (!$kontingen) {
            json_error('Kontingen tidak ditemukan.', 404);
        }

        $existing = $pdo->prepare('SELECT id, status FROM sesi_penilaian WHERE client_session_uuid = ?');
        $existing->execute([$uuid]);
        if ($row = $existing->fetch()) {
            json_response(['ok' => true, 'sesi_id' => (int)$row['id'], 'status' => $row['status']]);
        }

        $pdo->prepare("
            INSERT INTO sesi_penilaian (client_session_uuid, kegiatan_id, kontingen_id, pos_id, juri_id, status, timer_detik, bidak, waktu_mulai)
            VALUES (?, ?, ?, ?, ?, 'berjalan', 0, 0, ?)
        ")->execute([$uuid, $kegiatan['id'], $kontingenId, $posId, $user['id'], now_iso()]);

        json_response(['ok' => true, 'sesi_id' => (int)$pdo->lastInsertId(), 'status' => 'berjalan']);
    }

    if ($action === 'juri_session_cancel') {
        $uuid = trim((string)($body['client_session_uuid'] ?? ''));
        if ($uuid !== '') {
            $pdo->prepare("
                UPDATE sesi_penilaian SET status = 'dibatalkan', waktu_selesai = ?
                WHERE client_session_uuid = ? AND juri_id = ? AND status IN ('berjalan', 'draf')
            ")->execute([now_iso(), $uuid, $user['id']]);
        }
        json_response(['ok' => true]);
    }

    if ($action === 'juri_session_submit') {
        $uuid = trim((string)($body['client_session_uuid'] ?? ''));
        $posId = (int)($body['pos_id'] ?? 0);
        $kontingenId = (int)($body['kontingen_id'] ?? 0);
        $timerDetik = max(0, (int)($body['timer_detik'] ?? 0));
        $bidak = (float)($body['bidak'] ?? 0);
        $attendees = $body['peserta_roles'] ?? [];
        $scores = $body['scores'] ?? [];

        $pos = assert_judge_assigned($pdo, $posId, $user['id']);
        if ($uuid === '' || $kontingenId <= 0 || !is_array($attendees) || count($attendees) === 0 || !is_array($scores)) {
            json_error('Data sesi penilaian belum lengkap (minimal 1 peserta hadir dan nilai rubrik).', 400);
        }

        $kStmt = $pdo->prepare('SELECT id, kode FROM kontingen WHERE id = ? AND kegiatan_id = ?');
        $kStmt->execute([$kontingenId, $kegiatan['id']]);
        $kontingen = $kStmt->fetch();
        if (!$kontingen) {
            json_error('Kontingen tidak valid.', 400);
        }

        // Idempotency check
        $existStmt = $pdo->prepare('SELECT * FROM sesi_penilaian WHERE client_session_uuid = ?');
        $existStmt->execute([$uuid]);
        $existingSesi = $existStmt->fetch();
        if ($existingSesi && $existingSesi['status'] === 'selesai') {
            $receipt = get_receipt_payload($pdo, (int)$kegiatan['id'], $kontingen['kode'], $posId);
            json_response(['ok' => true, 'deduplicated' => true, 'sesi_id' => (int)$existingSesi['id'], 'receipt' => $receipt]);
        }

        // Load valid rubrics
        $rStmt = $pdo->prepare('SELECT * FROM rubrik WHERE pos_id = ?');
        $rStmt->execute([$posId]);
        $rubrikMap = [];
        foreach ($rStmt->fetchAll() as $r) {
            $rubrikMap[(int)$r['id']] = $r;
        }
        if (count($rubrikMap) === 0) {
            json_error('Pos belum memiliki rubrik penilaian.', 400);
        }

        // Validate scores
        $cleanScores = [];
        foreach ($scores as $s) {
            $rubId = (int)($s['rubrik_id'] ?? 0);
            $val = (float)($s['nilai'] ?? 0);
            $uidUnik = trim((string)($s['uid_unik'] ?? ($uuid . '-r' . $rubId)));
            if (!isset($rubrikMap[$rubId])) {
                json_error('Rubrik tidak sesuai dengan pos.', 400);
            }
            $maxVal = (float)$rubrikMap[$rubId]['nilai_maksimal'];
            if ($val < 0 || $val > $maxVal) {
                json_error("Nilai rubrik {$rubrikMap[$rubId]['nama']} harus antara 0 dan $maxVal.", 400);
            }
            $cleanScores[$rubId] = ['uid_unik' => $uidUnik, 'nilai' => $val];
        }

        // Validate attendees belong to kontingen
        $pCheckStmt = $pdo->prepare('SELECT id FROM peserta WHERE id = ? AND kontingen_id = ?');
        $cleanAttendees = [];
        foreach ($attendees as $a) {
            $pid = (int)($a['peserta_id'] ?? 0);
            $peran = trim((string)($a['peran_di_pos'] ?? 'Anggota'));
            if ($pid <= 0) continue;
            $pCheckStmt->execute([$pid, $kontingenId]);
            if (!$pCheckStmt->fetch()) {
                json_error('Peserta tidak termasuk dalam kontingen sesi ini.', 400);
            }
            $cleanAttendees[$pid] = $peran !== '' ? $peran : 'Anggota';
        }
        if (count($cleanAttendees) === 0) {
            json_error('Minimal satu peserta harus hadir dalam sesi.', 400);
        }

        $pdo->beginTransaction();
        try {
            $now = now_iso();
            if ($existingSesi) {
                $sesiId = (int)$existingSesi['id'];
                $pdo->prepare("
                    UPDATE sesi_penilaian
                    SET status = 'selesai', timer_detik = ?, bidak = ?, waktu_selesai = ?
                    WHERE id = ?
                ")->execute([$timerDetik, $bidak, $now, $sesiId]);
            } else {
                $pdo->prepare("
                    INSERT INTO sesi_penilaian (client_session_uuid, kegiatan_id, kontingen_id, pos_id, juri_id, status, timer_detik, bidak, waktu_mulai, waktu_selesai)
                    VALUES (?, ?, ?, ?, ?, 'selesai', ?, ?, ?, ?)
                ")->execute([$uuid, $kegiatan['id'], $kontingenId, $posId, $user['id'], $timerDetik, $bidak, $now, $now]);
                $sesiId = (int)$pdo->lastInsertId();
            }

            $khStmt = $pdo->prepare('
                INSERT INTO kehadiran (sesi_id, peserta_id, peran_di_pos) VALUES (?, ?, ?)
                ON CONFLICT(sesi_id, peserta_id) DO UPDATE SET peran_di_pos = excluded.peran_di_pos
            ');
            foreach ($cleanAttendees as $pid => $peran) {
                $khStmt->execute([$sesiId, $pid, $peran]);
            }

            $njStmt = $pdo->prepare('
                INSERT OR IGNORE INTO nilai_juri (uid_unik, sesi_id, juri_id, rubrik_id, nilai, timer, bidak, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ');
            foreach ($cleanScores as $rubId => $sc) {
                $njStmt->execute([$sc['uid_unik'], $sesiId, $user['id'], $rubId, $sc['nilai'], $timerDetik, $bidak, $now]);
            }

            $recalc = recalculate_nilai_akhir_pos($pdo, $kontingenId, $posId);
            write_log(
                $pdo,
                $user,
                'penilaian_selesai',
                "Penilaian selesai untuk {$kontingen['kode']} di {$pos['nama']} (nilai akhir pos: {$recalc['nilai_akhir']}).",
                "sesi:$sesiId",
                $kontingen['kode'],
                $pos['nama']
            );
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        $receipt = get_receipt_payload($pdo, (int)$kegiatan['id'], $kontingen['kode'], $posId);
        json_response(['ok' => true, 'deduplicated' => false, 'sesi_id' => $sesiId, 'receipt' => $receipt]);
    }

    if ($action === 'juri_get_receipt' || $action === 'juri_reprint_receipt') {
        $sesiId = (int)($_GET['sesi_id'] ?? $body['sesi_id'] ?? 0);
        $stmt = $pdo->prepare('
            SELECT sp.*, k.kode AS kontingen_kode, p.nama AS pos_nama
            FROM sesi_penilaian sp
            JOIN kontingen k ON k.id = sp.kontingen_id
            JOIN pos p ON p.id = sp.pos_id
            WHERE sp.id = ? AND sp.juri_id = ? AND sp.status = "selesai"
        ');
        $stmt->execute([$sesiId, $user['id']]);
        $sesi = $stmt->fetch();
        if (!$sesi) {
            json_error('Sesi tidak ditemukan.', 404);
        }

        if ($action === 'juri_reprint_receipt') {
            $pdo->prepare('UPDATE sesi_penilaian SET reprint_count = reprint_count + 1 WHERE id = ?')->execute([$sesiId]);
            $receipt = get_receipt_payload($pdo, (int)$sesi['kegiatan_id'], $sesi['kontingen_kode'], (int)$sesi['pos_id']);
            $label = ($receipt && $receipt['has_revisi']) ? 'REVISI' : 'DUPLIKAT';
            write_log($pdo, $user, 'cetak_ulang', "Cetak ulang struk ($label) {$sesi['kontingen_kode']} - {$sesi['pos_nama']}.", "sesi:$sesiId", $sesi['kontingen_kode'], $sesi['pos_nama']);
            json_response(['ok' => true, 'receipt' => $receipt, 'reprint_badge' => $label]);
        }

        $receipt = get_receipt_payload($pdo, (int)$sesi['kegiatan_id'], $sesi['kontingen_kode'], (int)$sesi['pos_id']);
        json_response(['ok' => true, 'receipt' => $receipt]);
    }

    if ($action === 'juri_get_session_detail') {
        $sesiId = (int)($_GET['sesi_id'] ?? 0);
        $stmt = $pdo->prepare('
            SELECT sp.*, k.kode AS kontingen_kode, p.nama AS pos_nama, p.pakai_timer, p.pakai_bidak
            FROM sesi_penilaian sp
            JOIN kontingen k ON k.id = sp.kontingen_id
            JOIN pos p ON p.id = sp.pos_id
            WHERE sp.id = ? AND sp.juri_id = ?
        ');
        $stmt->execute([$sesiId, $user['id']]);
        $sesi = $stmt->fetch();
        if (!$sesi) {
            json_error('Sesi tidak ditemukan.', 404);
        }

        $nStmt = $pdo->prepare('
            SELECT nj.rubrik_id, nj.nilai, r.nama, r.komponen, r.nilai_maksimal
            FROM nilai_juri nj
            JOIN rubrik r ON r.id = nj.rubrik_id
            WHERE nj.sesi_id = ?
            ORDER BY r.urutan ASC, r.id ASC
        ');
        $nStmt->execute([$sesiId]);
        $scores = $nStmt->fetchAll();

        $krStmt = $pdo->prepare('SELECT * FROM koreksi WHERE sesi_id = ? ORDER BY id DESC');
        $krStmt->execute([$sesiId]);
        $koreksi = $krStmt->fetchAll();

        json_response(['ok' => true, 'sesi' => $sesi, 'scores' => $scores, 'koreksi' => $koreksi]);
    }

    if ($action === 'juri_request_correction') {
        $sesiId = (int)($body['sesi_id'] ?? 0);
        $alasan = trim((string)($body['alasan'] ?? ''));
        $newScores = $body['scores'] ?? [];
        $newTimer = max(0, (int)($body['timer_detik'] ?? 0));
        $newBidak = (float)($body['bidak'] ?? 0);

        if ($sesiId <= 0 || $alasan === '' || !is_array($newScores)) {
            json_error('Alasan koreksi dan nilai baru wajib diisi.', 400);
        }

        $sStmt = $pdo->prepare('
            SELECT sp.*, k.kode AS kontingen_kode, p.nama AS pos_nama
            FROM sesi_penilaian sp
            JOIN kontingen k ON k.id = sp.kontingen_id
            JOIN pos p ON p.id = sp.pos_id
            WHERE sp.id = ? AND sp.juri_id = ? AND sp.status = "selesai"
        ');
        $sStmt->execute([$sesiId, $user['id']]);
        $sesi = $sStmt->fetch();
        if (!$sesi) {
            json_error('Sesi penilaian tidak ditemukan.', 404);
        }

        $rStmt = $pdo->prepare('
            SELECT nj.rubrik_id, nj.nilai, r.nama, r.nilai_maksimal
            FROM nilai_juri nj
            JOIN rubrik r ON r.id = nj.rubrik_id
            WHERE nj.sesi_id = ?
            ORDER BY r.urutan ASC, r.id ASC
        ');
        $rStmt->execute([$sesiId]);
        $oldRows = $rStmt->fetchAll();

        $oldMap = [];
        $oldTotal = 0.0;
        foreach ($oldRows as $row) {
            $oldMap[(int)$row['rubrik_id']] = [
                'rubrik_id' => (int)$row['rubrik_id'],
                'nama' => $row['nama'],
                'nilai' => (float)$row['nilai'],
                'nilai_maksimal' => (float)$row['nilai_maksimal'],
            ];
            $oldTotal += (float)$row['nilai'];
        }

        $newItems = [];
        $newTotal = 0.0;
        foreach ($newScores as $sc) {
            $rid = (int)($sc['rubrik_id'] ?? 0);
            $val = (float)($sc['nilai'] ?? 0);
            if (!isset($oldMap[$rid])) {
                json_error('Rubrik tidak valid.', 400);
            }
            if ($val < 0 || $val > $oldMap[$rid]['nilai_maksimal']) {
                json_error("Nilai {$oldMap[$rid]['nama']} melebihi batas maksimal.", 400);
            }
            $newItems[] = [
                'rubrik_id' => $rid,
                'nama' => $oldMap[$rid]['nama'],
                'nilai' => $val,
            ];
            $newTotal += $val;
        }

        $detailLama = json_encode([
            'scores' => array_values($oldMap),
            'timer_detik' => (int)$sesi['timer_detik'],
            'bidak' => (float)$sesi['bidak'],
            'total' => round($oldTotal, 2),
        ], JSON_UNESCAPED_UNICODE);

        $detailBaru = json_encode([
            'scores' => $newItems,
            'timer_detik' => $newTimer,
            'bidak' => $newBidak,
            'total' => round($newTotal, 2),
        ], JSON_UNESCAPED_UNICODE);

        $pdo->prepare("
            INSERT INTO koreksi (sesi_id, detail_lama, detail_baru, nilai_lama, nilai_baru, alasan, juri_pengaju_id, status, waktu_pengajuan)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'diajukan', ?)
        ")->execute([$sesiId, $detailLama, $detailBaru, round($oldTotal, 2), round($newTotal, 2), $alasan, $user['id'], now_iso()]);
        $kid = (int)$pdo->lastInsertId();

        write_log(
            $pdo,
            $user,
            'koreksi_diajukan',
            "Pengajuan koreksi {$sesi['kontingen_kode']} di {$sesi['pos_nama']} ($oldTotal -> $newTotal). Alasan: $alasan",
            "koreksi:$kid",
            $sesi['kontingen_kode'],
            $sesi['pos_nama']
        );

        json_response(['ok' => true, 'id' => $kid]);
    }

    json_error('Aksi juri tidak dikenal.', 404);
}
