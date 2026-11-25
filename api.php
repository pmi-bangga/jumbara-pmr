<?php
declare(strict_types=1);

require_once __DIR__ . '/api/db.php';
require_once __DIR__ . '/api/helpers.php';
require_once __DIR__ . '/api/auth.php';
require_once __DIR__ . '/api/pembina.php';
require_once __DIR__ . '/api/juri.php';
require_once __DIR__ . '/api/admin.php';

try {
    $pdo = get_db();
    $action = trim((string)($_GET['action'] ?? ''));
    $body = get_json_body();

    // Public endpoints (rate-limited, no login, strict public privacy rules)
    if (str_starts_with($action, 'public_')) {
        check_public_rate_limit($pdo, 240);

        if ($action === 'public_tv') {
            $kegiatan = get_active_kegiatan($pdo);
            if (!$kegiatan) {
                json_response(['ok' => true, 'kegiatan' => null, 'pos_list' => [], 'rows' => [], 'active_sessions' => []]);
            }

            $posStmt = $pdo->prepare('SELECT id, nama, urutan_tiebreaker FROM pos WHERE kegiatan_id = ? ORDER BY id ASC');
            $posStmt->execute([$kegiatan['id']]);
            $posList = $posStmt->fetchAll();

            // ONLY kontingen kode (NO school name, NO participant names/codes)
            $kStmt = $pdo->prepare('SELECT id, kode, tingkat, jenis FROM kontingen WHERE kegiatan_id = ? ORDER BY kode ASC');
            $kStmt->execute([$kegiatan['id']]);
            $kontingens = $kStmt->fetchAll();

            $napStmt = $pdo->prepare('SELECT kontingen_id, pos_id, nilai_akhir, has_revisi FROM nilai_akhir_pos WHERE kegiatan_id = ?');
            $napStmt->execute([$kegiatan['id']]);
            $napMap = [];
            foreach ($napStmt->fetchAll() as $n) {
                $napMap[(int)$n['kontingen_id']][(int)$n['pos_id']] = [
                    'nilai_akhir' => (float)$n['nilai_akhir'],
                    'has_revisi' => (bool)$n['has_revisi'],
                ];
            }

            $activeStmt = $pdo->prepare("
                SELECT DISTINCT k.kode AS kontingen_kode, sp.pos_id, p.nama AS pos_nama
                FROM sesi_penilaian sp
                JOIN kontingen k ON k.id = sp.kontingen_id
                JOIN pos p ON p.id = sp.pos_id
                WHERE sp.kegiatan_id = ? AND sp.status = 'berjalan'
                ORDER BY sp.id DESC
            ");
            $activeStmt->execute([$kegiatan['id']]);
            $activeSessions = $activeStmt->fetchAll();

            $activeMap = [];
            foreach ($activeSessions as $as) {
                $activeMap[$as['kontingen_kode']][(int)$as['pos_id']] = true;
            }

            $rows = [];
            foreach ($kontingens as $k) {
                $cells = [];
                foreach ($posList as $p) {
                    $pid = (int)$p['id'];
                    $score = $napMap[(int)$k['id']][$pid] ?? null;
                    $cells[$pid] = [
                        'nilai_akhir' => $score ? $score['nilai_akhir'] : null,
                        'has_revisi' => $score ? $score['has_revisi'] : false,
                        'sedang_dinilai' => isset($activeMap[$k['kode']][$pid]),
                    ];
                }
                $rows[] = [
                    'kode' => $k['kode'],
                    'tingkat' => $k['tingkat'],
                    'cells' => $cells,
                ];
            }

            json_response([
                'ok' => true,
                'kegiatan' => ['id' => (int)$kegiatan['id'], 'tahun' => (int)$kegiatan['tahun'], 'nama' => $kegiatan['nama']],
                'pos_list' => $posList,
                'rows' => $rows,
                'active_sessions' => $activeSessions,
                'server_time' => now_iso(),
            ]);
        }

        if ($action === 'public_nilai') {
            $kegId = (int)($_GET['kegiatan'] ?? 0);
            if ($kegId <= 0) {
                $act = get_active_kegiatan($pdo);
                $kegId = $act ? (int)$act['id'] : 0;
            }
            $kode = strtoupper(trim((string)($_GET['kontingen'] ?? '')));
            $posId = (int)($_GET['pos'] ?? 0);

            if ($kegId <= 0 || $kode === '' || $posId <= 0) {
                json_error('Parameter kegiatan, kontingen, dan pos tidak valid.', 400);
            }

            $payload = get_receipt_payload($pdo, $kegId, $kode, $posId);
            if (!$payload) {
                json_error('Data nilai untuk kontingen dan pos tersebut belum ditemukan.', 404);
            }

            // Strip school_nama and judge names from public display payload; keep public PDF transcript fields
            $publicReceiptPdf = [
                'kegiatan' => $payload['kegiatan'],
                'kontingen' => [
                    'kode' => $payload['kontingen']['kode'],
                    'tingkat' => $payload['kontingen']['tingkat'],
                    'jenis' => $payload['kontingen']['jenis'],
                ],
                'pos' => $payload['pos'],
                'rubriks' => $payload['rubriks'],
                'juri_breakdown' => array_map(fn($jb) => [
                    'juri_urutan' => $jb['juri_urutan'],
                    'juri_label' => 'Juri ' . $jb['juri_urutan'],
                    'waktu_selesai' => $jb['waktu_selesai'],
                    'timer_detik' => $jb['timer_detik'],
                    'bidak' => $jb['bidak'],
                    'total_juri' => $jb['total_juri'],
                    'komponen_subtotals' => $jb['komponen_subtotals'],
                    'rubrik_nilai' => $jb['rubrik_nilai'],
                ], $payload['juri_breakdown']),
                'nilai_akhir' => $payload['nilai_akhir'],
                'total_timer' => $payload['total_timer'],
                'bidak' => $payload['bidak'],
                'has_revisi' => $payload['has_revisi'],
            ];

            json_response([
                'ok' => true,
                'public_summary' => [
                    'kegiatan_nama' => $payload['kegiatan']['nama'],
                    'kontingen_kode' => $payload['kontingen']['kode'],
                    'pos_nama' => $payload['pos']['nama'],
                    'nilai_akhir' => $payload['nilai_akhir'],
                    'has_revisi' => $payload['has_revisi'],
                ],
                'pdf_transcript' => $publicReceiptPdf,
            ]);
        }

        json_error('Endpoint publik tidak dikenal.', 404);
    }

    // Auth endpoints
    if ($action === 'auth_me') {
        $user = get_optional_auth($pdo);
        $kegiatan = get_active_kegiatan($pdo);
        json_response(['ok' => true, 'user' => $user, 'kegiatan' => $kegiatan]);
    }

    if ($action === 'auth_login') {
        if (session_status() !== PHP_SESSION_ACTIVE) {
            session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'httponly' => true, 'samesite' => 'Lax']);
            session_start();
        }
        $username = strtolower(trim((string)($body['username'] ?? '')));
        $password = (string)($body['password'] ?? '');

        if ($username === '' || $password === '') {
            json_error('Username dan password wajib diisi.', 400);
        }

        $stmt = $pdo->prepare('SELECT * FROM akun WHERE LOWER(username) = ? LIMIT 1');
        $stmt->execute([$username]);
        $acc = $stmt->fetch();

        if (!$acc || !password_verify($password, $acc['password_hash'])) {
            json_error('Username atau password salah.', 401);
        }

        session_regenerate_id(true);
        $_SESSION['user_id'] = (int)$acc['id'];

        json_response([
            'ok' => true,
            'user' => [
                'id' => (int)$acc['id'],
                'username' => $acc['username'],
                'nama' => $acc['nama'],
                'peran' => $acc['peran'],
                'no_wa' => $acc['no_wa'],
                'wajib_ganti_password' => (bool)$acc['wajib_ganti_password'],
            ],
        ]);
    }

    if ($action === 'auth_register_pembina') {
        if (session_status() !== PHP_SESSION_ACTIVE) {
            session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'httponly' => true, 'samesite' => 'Lax']);
            session_start();
        }
        $nama = trim((string)($body['nama'] ?? ''));
        $username = strtolower(trim((string)($body['username'] ?? '')));
        $wa = normalize_wa((string)($body['no_wa'] ?? ''));
        $password = (string)($body['password'] ?? '');

        if ($nama === '' || !preg_match('/^[a-z0-9_.-]{3,30}$/', $username) || $wa === '' || strlen($password) < 6) {
            json_error('Nama, username (huruf/angka 3-30 karakter), nomor WhatsApp wajib, dan password minimal 6 karakter harus diisi.', 400);
        }

        $exists = $pdo->prepare('SELECT id FROM akun WHERE LOWER(username) = ?');
        $exists->execute([$username]);
        if ($exists->fetch()) {
            json_error('Username sudah terdaftar.', 400);
        }

        $pdo->prepare("
            INSERT INTO akun (username, nama, peran, no_wa, password_hash, wajib_ganti_password, created_at)
            VALUES (?, ?, 'pembina', ?, ?, 0, ?)
        ")->execute([$username, $nama, $wa, password_hash($password, PASSWORD_DEFAULT), now_iso()]);
        $newId = (int)$pdo->lastInsertId();

        $actor = ['id' => $newId, 'nama' => $nama, 'peran' => 'pembina'];
        write_log($pdo, $actor, 'pendaftaran_pembina', "Akun pembina baru mendaftar: $nama (@$username, WA: $wa).", "akun:$newId");

        session_regenerate_id(true);
        $_SESSION['user_id'] = $newId;

        json_response([
            'ok' => true,
            'user' => [
                'id' => $newId,
                'username' => $username,
                'nama' => $nama,
                'peran' => 'pembina',
                'no_wa' => $wa,
                'wajib_ganti_password' => false,
            ],
        ]);
    }

    if ($action === 'auth_logout') {
        if (session_status() !== PHP_SESSION_ACTIVE) {
            session_start();
        }
        $_SESSION = [];
        session_destroy();
        json_response(['ok' => true]);
    }

    if ($action === 'auth_change_password') {
        $user = require_auth($pdo);
        $newPass = (string)($body['new_password'] ?? '');
        if (strlen($newPass) < 6) {
            json_error('Password baru minimal 6 karakter.', 400);
        }

        $pdo->prepare('UPDATE akun SET password_hash = ?, wajib_ganti_password = 0 WHERE id = ?')
            ->execute([password_hash($newPass, PASSWORD_DEFAULT), $user['id']]);
        write_log($pdo, $user, 'ganti_password', "Pengguna {$user['nama']} (@{$user['username']}) mengganti password.");
        json_response(['ok' => true]);
    }

    // All remaining endpoints require auth AND completed temporary password change
    $user = require_auth($pdo);
    if ($user['wajib_ganti_password']) {
        json_error('Anda wajib mengganti password sementara sebelum menggunakan sistem.', 403, ['require_password_change' => true]);
    }

    if (str_starts_with($action, 'pembina_')) {
        if ($user['peran'] !== 'pembina') json_error('Akses khusus pembina.', 403);
        handle_pembina_action($pdo, $user, $action, $body);
    } elseif (str_starts_with($action, 'juri_')) {
        if ($user['peran'] !== 'juri') json_error('Akses khusus juri.', 403);
        handle_juri_action($pdo, $user, $action, $body);
    } elseif (str_starts_with($action, 'admin_')) {
        if ($user['peran'] !== 'admin') json_error('Akses khusus admin.', 403);
        handle_admin_action($pdo, $user, $action, $body);
    } else {
        json_error('Endpoint tidak ditemukan.', 404);
    }
} catch (Throwable $e) {
    json_error('Terjadi kesalahan server: ' . $e->getMessage(), 500);
}
