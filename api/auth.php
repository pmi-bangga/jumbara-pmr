<?php
declare(strict_types=1);

function require_auth(PDO $pdo, ?array $allowedRoles = null): array {
    if (session_status() !== PHP_SESSION_ACTIVE) {
        session_set_cookie_params([
            'lifetime' => 0,
            'path' => '/',
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        session_start();
    }

    $userId = $_SESSION['user_id'] ?? null;
    if (!$userId) {
        json_error('Silakan login terlebih dahulu.', 401);
    }

    $stmt = $pdo->prepare('SELECT id, username, nama, peran, no_wa, wajib_ganti_password, created_at FROM akun WHERE id = ?');
    $stmt->execute([$userId]);
    $user = $stmt->fetch();

    if (!$user) {
        session_destroy();
        json_error('Sesi akun tidak ditemukan.', 401);
    }

    $user['id'] = (int)$user['id'];
    $user['wajib_ganti_password'] = (bool)$user['wajib_ganti_password'];

    if ($allowedRoles !== null && !in_array($user['peran'], $allowedRoles, true)) {
        json_error('Anda tidak memiliki izin untuk mengakses fitur ini.', 403);
    }

    return $user;
}

function get_optional_auth(PDO $pdo): ?array {
    if (session_status() !== PHP_SESSION_ACTIVE) {
        session_set_cookie_params([
            'lifetime' => 0,
            'path' => '/',
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        session_start();
    }
    $userId = $_SESSION['user_id'] ?? null;
    if (!$userId) return null;

    $stmt = $pdo->prepare('SELECT id, username, nama, peran, no_wa, wajib_ganti_password, created_at FROM akun WHERE id = ?');
    $stmt->execute([$userId]);
    $user = $stmt->fetch();
    if (!$user) return null;

    $user['id'] = (int)$user['id'];
    $user['wajib_ganti_password'] = (bool)$user['wajib_ganti_password'];
    return $user;
}
