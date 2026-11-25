<?php
declare(strict_types=1);

function get_db(): PDO {
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $dataDir = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data';
    if (!is_dir($dataDir)) {
        mkdir($dataDir, 0775, true);
    }

    $dbPath = $dataDir . DIRECTORY_SEPARATOR . 'jumbara.sqlite';
    $isNew = !file_exists($dbPath);

    $pdo = new PDO('sqlite:' . $dbPath, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);

    $pdo->exec('PRAGMA journal_mode = WAL;');
    $pdo->exec('PRAGMA foreign_keys = ON;');
    $pdo->exec('PRAGMA busy_timeout = 5000;');

    init_schema($pdo);

    if ($isNew || (int)$pdo->query('SELECT COUNT(*) FROM akun')->fetchColumn() === 0) {
        require_once __DIR__ . '/seed.php';
        seed_initial_data($pdo);
    }

    return $pdo;
}

function init_schema(PDO $pdo): void {
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS akun (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            nama TEXT NOT NULL,
            peran TEXT NOT NULL CHECK(peran IN ('pembina', 'juri', 'admin')),
            no_wa TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            wajib_ganti_password INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS kegiatan (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tahun INTEGER NOT NULL UNIQUE,
            nama TEXT NOT NULL,
            tingkat_aktif TEXT NOT NULL,
            tanggal TEXT NOT NULL,
            hari_kunci TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sekolah (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nama TEXT NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS kontingen (
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
        );

        CREATE TABLE IF NOT EXISTS peserta (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kontingen_id INTEGER NOT NULL REFERENCES kontingen(id) ON DELETE CASCADE,
            kegiatan_id INTEGER NOT NULL REFERENCES kegiatan(id) ON DELETE CASCADE,
            kode_peserta TEXT NOT NULL,
            nama TEXT NOT NULL,
            tanggal_lahir TEXT NOT NULL,
            kontak TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            UNIQUE(kegiatan_id, kode_peserta)
        );

        CREATE TABLE IF NOT EXISTS pos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kegiatan_id INTEGER NOT NULL REFERENCES kegiatan(id) ON DELETE CASCADE,
            nama TEXT NOT NULL,
            urutan_tiebreaker INTEGER NOT NULL DEFAULT 1,
            jumlah_juri INTEGER NOT NULL DEFAULT 1 CHECK(jumlah_juri BETWEEN 1 AND 3),
            cara_gabung TEXT NOT NULL DEFAULT 'rata_rata' CHECK(cara_gabung IN ('jumlah', 'rata_rata')),
            pakai_timer INTEGER NOT NULL DEFAULT 0,
            pakai_bidak INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS penugasan_juri (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pos_id INTEGER NOT NULL REFERENCES pos(id) ON DELETE CASCADE,
            juri_id INTEGER NOT NULL REFERENCES akun(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            UNIQUE(pos_id, juri_id)
        );

        CREATE TABLE IF NOT EXISTS rubrik (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pos_id INTEGER NOT NULL REFERENCES pos(id) ON DELETE CASCADE,
            nama TEXT NOT NULL,
            komponen TEXT NOT NULL DEFAULT 'Umum' CHECK(komponen IN ('Umum', 'Teori', 'Praktik')),
            nilai_maksimal REAL NOT NULL,
            urutan INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS sesi_penilaian (
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
        );

        CREATE TABLE IF NOT EXISTS kehadiran (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sesi_id INTEGER NOT NULL REFERENCES sesi_penilaian(id) ON DELETE CASCADE,
            peserta_id INTEGER NOT NULL REFERENCES peserta(id) ON DELETE CASCADE,
            peran_di_pos TEXT NOT NULL,
            UNIQUE(sesi_id, peserta_id)
        );

        CREATE TABLE IF NOT EXISTS nilai_juri (
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
        );

        CREATE TABLE IF NOT EXISTS nilai_akhir_pos (
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
        );

        CREATE TABLE IF NOT EXISTS koreksi (
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
        );

        CREATE TABLE IF NOT EXISTS log (
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
        );

        CREATE TABLE IF NOT EXISTS rate_limits (
            ip TEXT NOT NULL,
            window_start INTEGER NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(ip, window_start)
        );

        CREATE INDEX IF NOT EXISTS idx_peserta_kode ON peserta(kode_peserta);
        CREATE INDEX IF NOT EXISTS idx_sesi_status ON sesi_penilaian(kegiatan_id, status);
        CREATE INDEX IF NOT EXISTS idx_log_waktu ON log(waktu DESC);
        CREATE INDEX IF NOT EXISTS idx_nilai_akhir_keg ON nilai_akhir_pos(kegiatan_id);
    ");
}
