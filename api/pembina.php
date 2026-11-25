<?php
declare(strict_types=1);

function handle_pembina_action(PDO $pdo, array $user, string $action, array $body): void {
    $kegiatan = get_active_kegiatan($pdo);

    if ($action === 'pembina_dashboard') {
        if (!$kegiatan) {
            json_response(['ok' => true, 'kegiatan' => null, 'sekolah' => [], 'kontingen' => null, 'peserta' => []]);
        }
        $schools = $pdo->query('SELECT id, nama FROM sekolah ORDER BY nama ASC')->fetchAll();

        $kStmt = $pdo->prepare('
            SELECT k.*, s.nama AS sekolah_nama
            FROM kontingen k
            JOIN sekolah s ON s.id = k.sekolah_id
            WHERE k.kegiatan_id = ? AND k.pembina_id = ?
            LIMIT 1
        ');
        $kStmt->execute([$kegiatan['id'], $user['id']]);
        $kontingen = $kStmt->fetch() ?: null;

        $peserta = [];
        if ($kontingen) {
            $kontingen['is_locked'] = is_kontingen_locked($kegiatan, $kontingen);
            $pStmt = $pdo->prepare('SELECT * FROM peserta WHERE kontingen_id = ? ORDER BY kode_peserta ASC');
            $pStmt->execute([$kontingen['id']]);
            $peserta = $pStmt->fetchAll();
        }

        json_response([
            'ok' => true,
            'kegiatan' => $kegiatan,
            'sekolah' => $schools,
            'kontingen' => $kontingen,
            'peserta' => $peserta,
        ]);
    }

    if (!$kegiatan) {
        json_error('Belum ada kegiatan aktif.', 400);
    }

    if ($action === 'pembina_create_kontingen') {
        $sekolahId = (int)($body['sekolah_id'] ?? 0);
        $tingkat = trim((string)($body['tingkat'] ?? ''));
        $jenis = trim((string)($body['jenis'] ?? ''));

        if ($sekolahId <= 0 || !in_array($tingkat, ['Mula', 'Madya', 'Wira'], true) || !in_array($jenis, ['putra', 'putri', 'gabungan'], true)) {
            json_error('Sekolah, tingkat, dan jenis kontingen wajib dipilih.', 400);
        }
        if (!in_array($tingkat, $kegiatan['tingkat_aktif'], true)) {
            json_error("Tingkat $tingkat tidak aktif pada kegiatan tahun ini.", 400);
        }
        if (today_date() >= $kegiatan['hari_kunci']) {
            json_error('Pendaftaran sudah dikunci mulai hari kunci.', 403);
        }

        $existsSelf = $pdo->prepare('SELECT id FROM kontingen WHERE kegiatan_id = ? AND pembina_id = ?');
        $existsSelf->execute([$kegiatan['id'], $user['id']]);
        if ($existsSelf->fetch()) {
            json_error('Satu pembina hanya mengelola satu kontingen per kegiatan.', 400);
        }

        $schoolStmt = $pdo->prepare('SELECT id, nama FROM sekolah WHERE id = ?');
        $schoolStmt->execute([$sekolahId]);
        $school = $schoolStmt->fetch();
        if (!$school) {
            json_error('Sekolah tidak ditemukan dalam daftar admin.', 400);
        }

        // Check school rules: 1 gabungan OR up to 2 (putra & putri)
        $schKStmt = $pdo->prepare('SELECT jenis FROM kontingen WHERE kegiatan_id = ? AND sekolah_id = ?');
        $schKStmt->execute([$kegiatan['id'], $sekolahId]);
        $existingJenis = $schKStmt->fetchAll(PDO::FETCH_COLUMN);
        if (in_array('gabungan', $existingJenis, true) || ($jenis === 'gabungan' && count($existingJenis) > 0) || in_array($jenis, $existingJenis, true)) {
            json_error('Sekolah ini sudah memiliki kontingen untuk jenis tersebut (maksimal 1 gabungan, atau 1 putra dan 1 putri terpisah).', 400);
        }

        $prefix = tingkat_prefix($tingkat);
        $maxStmt = $pdo->prepare('SELECT kode FROM kontingen WHERE kegiatan_id = ? AND kode LIKE ?');
        $maxStmt->execute([$kegiatan['id'], $prefix . '%']);
        $maxNum = 0;
        foreach ($maxStmt->fetchAll(PDO::FETCH_COLUMN) as $kCode) {
            $num = (int)substr($kCode, 2);
            if ($num > $maxNum) $maxNum = $num;
        }
        $kode = $prefix . str_pad((string)($maxNum + 1), 3, '0', STR_PAD_LEFT);

        $pdo->prepare("
            INSERT INTO kontingen (kegiatan_id, sekolah_id, tingkat, jenis, kode, pembina_id, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'terbuka', ?)
        ")->execute([$kegiatan['id'], $sekolahId, $tingkat, $jenis, $kode, $user['id'], now_iso()]);
        $kid = (int)$pdo->lastInsertId();

        write_log($pdo, $user, 'pendaftaran_kontingen', "Kontingen $kode ({$school['nama']} - $tingkat $jenis) didaftarkan.", "kontingen:$kid", $kode);

        json_response(['ok' => true, 'kode' => $kode, 'id' => $kid]);
    }

    // Load pembina kontingen
    $kStmt = $pdo->prepare('SELECT * FROM kontingen WHERE kegiatan_id = ? AND pembina_id = ? LIMIT 1');
    $kStmt->execute([$kegiatan['id'], $user['id']]);
    $kontingen = $kStmt->fetch();
    if (!$kontingen) {
        json_error('Kontingen Anda belum dibuat.', 400);
    }

    if (is_kontingen_locked($kegiatan, $kontingen)) {
        json_error('Data kontingen sudah dikunci mulai hari kunci. Hubungi admin jika ada perubahan mendesak.', 403);
    }

    if ($action === 'pembina_add_peserta') {
        $nama = trim((string)($body['nama'] ?? ''));
        $tglLahir = trim((string)($body['tanggal_lahir'] ?? ''));
        $kontak = trim((string)($body['kontak'] ?? ''));

        if ($nama === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $tglLahir)) {
            json_error('Nama dan tanggal lahir (YYYY-MM-DD) peserta wajib diisi.', 400);
        }

        // Prevent same participant name + dob in another kontingen in same kegiatan
        $dupStmt = $pdo->prepare('
            SELECT p.kode_peserta, k.kode
            FROM peserta p JOIN kontingen k ON k.id = p.kontingen_id
            WHERE p.kegiatan_id = ? AND LOWER(TRIM(p.nama)) = LOWER(?) AND p.tanggal_lahir = ?
        ');
        $dupStmt->execute([$kegiatan['id'], $nama, $tglLahir]);
        if ($dup = $dupStmt->fetch()) {
            json_error("Peserta dengan nama & tanggal lahir tersebut sudah terdaftar di kontingen {$dup['kode']} ({$dup['kode_peserta']}).", 400);
        }

        $pCodes = $pdo->prepare('SELECT kode_peserta FROM peserta WHERE kontingen_id = ?');
        $pCodes->execute([$kontingen['id']]);
        $maxSeq = 0;
        foreach ($pCodes->fetchAll(PDO::FETCH_COLUMN) as $pc) {
            $seq = (int)substr($pc, 5, 2);
            if ($seq > $maxSeq) $maxSeq = $seq;
        }
        $nextSeq = $maxSeq + 1;
        if ($nextSeq > 99) {
            json_error('Maksimal 99 peserta per kontingen.', 400);
        }
        $kodePeserta = $kontingen['kode'] . str_pad((string)$nextSeq, 2, '0', STR_PAD_LEFT);

        $pdo->prepare('
            INSERT INTO peserta (kontingen_id, kegiatan_id, kode_peserta, nama, tanggal_lahir, kontak, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ')->execute([$kontingen['id'], $kegiatan['id'], $kodePeserta, $nama, $tglLahir, $kontak, now_iso()]);
        $pid = (int)$pdo->lastInsertId();

        write_log($pdo, $user, 'tambah_peserta', "Peserta $kodePeserta ($nama) ditambahkan ke kontingen {$kontingen['kode']}.", "peserta:$pid", $kontingen['kode']);

        json_response(['ok' => true, 'id' => $pid, 'kode_peserta' => $kodePeserta]);
    }

    if ($action === 'pembina_update_peserta') {
        $pesertaId = (int)($body['id'] ?? 0);
        $nama = trim((string)($body['nama'] ?? ''));
        $tglLahir = trim((string)($body['tanggal_lahir'] ?? ''));
        $kontak = trim((string)($body['kontak'] ?? ''));

        if ($pesertaId <= 0 || $nama === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $tglLahir)) {
            json_error('Data peserta tidak lengkap.', 400);
        }

        $pStmt = $pdo->prepare('SELECT * FROM peserta WHERE id = ? AND kontingen_id = ?');
        $pStmt->execute([$pesertaId, $kontingen['id']]);
        $existing = $pStmt->fetch();
        if (!$existing) {
            json_error('Peserta tidak ditemukan pada kontingen Anda.', 404);
        }

        $pdo->prepare('UPDATE peserta SET nama = ?, tanggal_lahir = ?, kontak = ? WHERE id = ?')
            ->execute([$nama, $tglLahir, $kontak, $pesertaId]);

        write_log($pdo, $user, 'ubah_peserta', "Data peserta {$existing['kode_peserta']} diubah ({$existing['nama']} -> $nama).", "peserta:$pesertaId", $kontingen['kode']);
        json_response(['ok' => true]);
    }

    if ($action === 'pembina_delete_peserta') {
        $pesertaId = (int)($body['id'] ?? 0);
        $pStmt = $pdo->prepare('SELECT * FROM peserta WHERE id = ? AND kontingen_id = ?');
        $pStmt->execute([$pesertaId, $kontingen['id']]);
        $existing = $pStmt->fetch();
        if (!$existing) {
            json_error('Peserta tidak ditemukan.', 404);
        }

        $pdo->prepare('DELETE FROM peserta WHERE id = ?')->execute([$pesertaId]);
        write_log($pdo, $user, 'hapus_peserta', "Peserta {$existing['kode_peserta']} ({$existing['nama']}) dihapus dari kontingen {$kontingen['kode']}.", "peserta:$pesertaId", $kontingen['kode']);
        json_response(['ok' => true]);
    }

    json_error('Aksi pembina tidak dikenal.', 404);
}
