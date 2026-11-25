<?php
declare(strict_types=1);

function now_iso(): string {
    $tz = new DateTimeZone('Asia/Jakarta');
    return (new DateTimeImmutable('now', $tz))->format('Y-m-d H:i:s');
}

function today_date(): string {
    $tz = new DateTimeZone('Asia/Jakarta');
    return (new DateTimeImmutable('now', $tz))->format('Y-m-d');
}

function json_response(array $data, int $status = 200): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function json_error(string $message, int $status = 400, array $extra = []): void {
    json_response(array_merge(['ok' => false, 'error' => $message], $extra), $status);
}

function get_json_body(): array {
    $raw = file_get_contents('php://input');
    if (!$raw) {
        return $_POST ?: [];
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function normalize_wa(string $wa): string {
    $digits = preg_replace('/\D+/', '', trim($wa));
    if ($digits === '') return '';
    if (str_starts_with($digits, '0')) {
        $digits = '62' . substr($digits, 1);
    } elseif (str_starts_with($digits, '8')) {
        $digits = '62' . $digits;
    }
    return $digits;
}

function tingkat_prefix(string $tingkat): string {
    return match ($tingkat) {
        'Mula' => 'MU',
        'Madya' => 'MA',
        'Wira' => 'WI',
        default => throw new InvalidArgumentException('Tingkat tidak valid'),
    };
}

function check_public_rate_limit(PDO $pdo, int $maxPerMinute = 180): void {
    $ip = $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';
    $window = (int)floor(time() / 60);

    $pdo->prepare('DELETE FROM rate_limits WHERE window_start < ?')->execute([$window - 2]);
    $stmt = $pdo->prepare('SELECT count FROM rate_limits WHERE ip = ? AND window_start = ?');
    $stmt->execute([$ip, $window]);
    $count = (int)($stmt->fetchColumn() ?: 0);

    if ($count >= $maxPerMinute) {
        json_error('Terlalu banyak permintaan. Silakan tunggu sebentar.', 429);
    }

    $pdo->prepare('
        INSERT INTO rate_limits (ip, window_start, count) VALUES (?, ?, 1)
        ON CONFLICT(ip, window_start) DO UPDATE SET count = count + 1
    ')->execute([$ip, $window]);
}

function write_log(
    PDO $pdo,
    ?array $actor,
    string $jenisAktivitas,
    string $detail,
    string $rujukanData = '',
    string $kontingenKode = '',
    string $posNama = ''
): void {
    $stmt = $pdo->prepare('
        INSERT INTO log (waktu, pelaku_id, pelaku_nama, pelaku_peran, jenis_aktivitas, rujukan_data, kontingen_kode, pos_nama, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ');
    $stmt->execute([
        now_iso(),
        $actor['id'] ?? null,
        $actor['nama'] ?? 'Sistem',
        $actor['peran'] ?? 'sistem',
        $jenisAktivitas,
        $rujukanData,
        $kontingenKode,
        $posNama,
        $detail,
    ]);
}

function get_active_kegiatan(PDO $pdo): ?array {
    $row = $pdo->query('SELECT * FROM kegiatan WHERE is_active = 1 ORDER BY tahun DESC LIMIT 1')->fetch();
    if (!$row) {
        $row = $pdo->query('SELECT * FROM kegiatan ORDER BY tahun DESC LIMIT 1')->fetch();
    }
    if ($row) {
        $row['tingkat_aktif'] = json_decode($row['tingkat_aktif'], true) ?: [];
        $row['is_locked_by_date'] = today_date() >= $row['hari_kunci'];
    }
    return $row ?: null;
}

function is_kontingen_locked(array $kegiatan, array $kontingen): bool {
    return ($kontingen['status'] ?? 'terbuka') === 'terkunci' || today_date() >= ($kegiatan['hari_kunci'] ?? '9999-12-31');
}

function recalculate_nilai_akhir_pos(PDO $pdo, int $kontingenId, int $posId): array {
    $pos = $pdo->prepare('SELECT * FROM pos WHERE id = ?');
    $pos->execute([$posId]);
    $posRow = $pos->fetch();
    if (!$posRow) {
        throw new RuntimeException('Pos tidak ditemukan');
    }

    $kontingenStmt = $pdo->prepare('SELECT * FROM kontingen WHERE id = ?');
    $kontingenStmt->execute([$kontingenId]);
    $kontingenRow = $kontingenStmt->fetch();
    if (!$kontingenRow) {
        throw new RuntimeException('Kontingen tidak ditemukan');
    }

    // Latest completed session per judge for this kontingen & pos
    $sesiStmt = $pdo->prepare("
        SELECT s.*
        FROM sesi_penilaian s
        INNER JOIN (
            SELECT juri_id, MAX(id) AS max_id
            FROM sesi_penilaian
            WHERE kontingen_id = ? AND pos_id = ? AND status = 'selesai'
            GROUP BY juri_id
        ) latest ON latest.max_id = s.id
        ORDER BY s.juri_id ASC
    ");
    $sesiStmt->execute([$kontingenId, $posId]);
    $sessions = $sesiStmt->fetchAll();

    if (!$sessions) {
        $pdo->prepare('DELETE FROM nilai_akhir_pos WHERE kontingen_id = ? AND pos_id = ?')
            ->execute([$kontingenId, $posId]);
        return ['nilai_akhir' => 0, 'total_timer' => 0, 'bidak' => 0, 'has_revisi' => 0];
    }

    $judgeTotals = [];
    $timers = [];
    $bidaks = [];
    $sessionIds = [];

    foreach ($sessions as $sesi) {
        $sessionIds[] = (int)$sesi['id'];
        $sumStmt = $pdo->prepare('SELECT COALESCE(SUM(nilai), 0) FROM nilai_juri WHERE sesi_id = ?');
        $sumStmt->execute([$sesi['id']]);
        $judgeTotals[] = (float)$sumStmt->fetchColumn();
        $timers[] = (int)$sesi['timer_detik'];
        $bidaks[] = (float)$sesi['bidak'];
    }

    if ($posRow['cara_gabung'] === 'jumlah') {
        $nilaiAkhir = round(array_sum($judgeTotals), 2);
    } else {
        $nilaiAkhir = round(array_sum($judgeTotals) / max(1, count($judgeTotals)), 2);
    }

    $totalTimer = $posRow['pakai_timer'] ? (int)round(array_sum($timers) / max(1, count($timers))) : 0;
    $bidak = $posRow['pakai_bidak'] ? round(array_sum($bidaks) / max(1, count($bidaks)), 2) : 0;

    $placeholders = implode(',', array_fill(0, count($sessionIds), '?'));
    $revStmt = $pdo->prepare("SELECT COUNT(*) FROM koreksi WHERE sesi_id IN ($placeholders) AND status = 'disetujui'");
    $revStmt->execute($sessionIds);
    $hasRevisi = ((int)$revStmt->fetchColumn() > 0) ? 1 : 0;

    $pdo->prepare("
        INSERT INTO nilai_akhir_pos (kegiatan_id, kontingen_id, pos_id, nilai_akhir, total_timer, bidak, has_revisi, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(kontingen_id, pos_id) DO UPDATE SET
            nilai_akhir = excluded.nilai_akhir,
            total_timer = excluded.total_timer,
            bidak = excluded.bidak,
            has_revisi = excluded.has_revisi,
            updated_at = excluded.updated_at
    ")->execute([
        (int)$kontingenRow['kegiatan_id'],
        $kontingenId,
        $posId,
        $nilaiAkhir,
        $totalTimer,
        $bidak,
        $hasRevisi,
        now_iso(),
    ]);

    return [
        'nilai_akhir' => $nilaiAkhir,
        'total_timer' => $totalTimer,
        'bidak' => $bidak,
        'has_revisi' => $hasRevisi,
    ];
}

function generate_temp_password(int $length = 8): string {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $out = '';
    for ($i = 0; $i < $length; $i++) {
        $out .= $chars[random_int(0, strlen($chars) - 1)];
    }
    return $out;
}

function get_receipt_payload(PDO $pdo, int $kegiatanId, string $kontingenKode, int $posId): ?array {
    $kStmt = $pdo->prepare('SELECT * FROM kegiatan WHERE id = ?');
    $kStmt->execute([$kegiatanId]);
    $kegiatan = $kStmt->fetch();

    $cStmt = $pdo->prepare('
        SELECT k.*, s.nama AS sekolah_nama
        FROM kontingen k
        JOIN sekolah s ON s.id = k.sekolah_id
        WHERE k.kegiatan_id = ? AND k.kode = ?
    ');
    $cStmt->execute([$kegiatanId, $kontingenKode]);
    $kontingen = $cStmt->fetch();

    $pStmt = $pdo->prepare('SELECT * FROM pos WHERE id = ? AND kegiatan_id = ?');
    $pStmt->execute([$posId, $kegiatanId]);
    $pos = $pStmt->fetch();

    if (!$kegiatan || !$kontingen || !$pos) {
        return null;
    }

    $rStmt = $pdo->prepare('SELECT * FROM rubrik WHERE pos_id = ? ORDER BY urutan ASC, id ASC');
    $rStmt->execute([$posId]);
    $rubriks = $rStmt->fetchAll();

    $sesiStmt = $pdo->prepare("
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
    ");
    $sesiStmt->execute([(int)$kontingen['id'], $posId]);
    $sessions = $sesiStmt->fetchAll();

    $napStmt = $pdo->prepare('SELECT * FROM nilai_akhir_pos WHERE kontingen_id = ? AND pos_id = ?');
    $napStmt->execute([(int)$kontingen['id'], $posId]);
    $nilaiAkhir = $napStmt->fetch();

    $juriBreakdown = [];
    $hasRevisi = (bool)($nilaiAkhir['has_revisi'] ?? false);

    foreach ($sessions as $idx => $sesi) {
        $nStmt = $pdo->prepare('
            SELECT nj.rubrik_id, nj.nilai, r.nama AS rubrik_nama, r.komponen, r.nilai_maksimal, r.urutan
            FROM nilai_juri nj
            JOIN rubrik r ON r.id = nj.rubrik_id
            WHERE nj.sesi_id = ?
            ORDER BY r.urutan ASC, r.id ASC
        ');
        $nStmt->execute([$sesi['id']]);
        $items = $nStmt->fetchAll();

        $totalJuri = 0.0;
        $komponenSubtotals = [];
        foreach ($items as $item) {
            $val = (float)$item['nilai'];
            $totalJuri += $val;
            $komp = $item['komponen'] ?: 'Umum';
            $komponenSubtotals[$komp] = ($komponenSubtotals[$komp] ?? 0.0) + $val;
        }

        $juriBreakdown[] = [
            'sesi_id' => (int)$sesi['id'],
            'juri_urutan' => $idx + 1,
            'juri_nama' => $sesi['juri_nama'],
            'waktu_selesai' => $sesi['waktu_selesai'],
            'timer_detik' => (int)$sesi['timer_detik'],
            'bidak' => (float)$sesi['bidak'],
            'reprint_count' => (int)$sesi['reprint_count'],
            'total_juri' => round($totalJuri, 2),
            'komponen_subtotals' => $komponenSubtotals,
            'rubrik_nilai' => $items,
        ];
    }

    return [
        'kegiatan' => [
            'id' => (int)$kegiatan['id'],
            'tahun' => (int)$kegiatan['tahun'],
            'nama' => $kegiatan['nama'],
        ],
        'kontingen' => [
            'id' => (int)$kontingen['id'],
            'kode' => $kontingen['kode'],
            'tingkat' => $kontingen['tingkat'],
            'jenis' => $kontingen['jenis'],
            'sekolah_nama' => $kontingen['sekolah_nama'],
        ],
        'pos' => [
            'id' => (int)$pos['id'],
            'nama' => $pos['nama'],
            'jumlah_juri' => (int)$pos['jumlah_juri'],
            'cara_gabung' => $pos['cara_gabung'],
            'pakai_timer' => (bool)$pos['pakai_timer'],
            'pakai_bidak' => (bool)$pos['pakai_bidak'],
        ],
        'rubriks' => $rubriks,
        'juri_breakdown' => $juriBreakdown,
        'nilai_akhir' => $nilaiAkhir ? (float)$nilaiAkhir['nilai_akhir'] : 0.0,
        'total_timer' => $nilaiAkhir ? (int)$nilaiAkhir['total_timer'] : 0,
        'bidak' => $nilaiAkhir ? (float)$nilaiAkhir['bidak'] : 0.0,
        'has_revisi' => $hasRevisi,
        'qr_url' => 'publik.html?kegiatan=' . (int)$kegiatan['id'] . '&kontingen=' . rawurlencode($kontingen['kode']) . '&pos=' . (int)$pos['id'],
    ];
}
