import {
  nowIso,
  jsonResponse,
  jsonError,
  getJsonBody,
  normalizeWa,
  hashPassword,
  verifyPassword,
  checkPublicRateLimit,
  writeLog,
  getActiveKegiatan,
  getReceiptPayload,
} from './_lib/helpers.js';
import {
  createSessionCookie,
  clearSessionCookie,
  getOptionalAuth,
  requireAuth,
} from './_lib/auth.js';
import { ensureSeeded } from './_lib/seed.js';
import { handlePembinaAction } from './_lib/pembina.js';
import { handleJuriAction } from './_lib/juri.js';
import { handleAdminAction } from './_lib/admin.js';

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  if (!db) {
    return jsonError('Binding D1 database (DB) belum dikonfigurasi di Cloudflare.', 500);
  }

  try {
    await ensureSeeded(db);

    const url = new URL(request.url);
    const action = (url.searchParams.get('action') || '').trim();
    const body = await getJsonBody(request);

    // Public endpoints (rate-limited, no login, strict public privacy rules)
    if (action.startsWith('public_')) {
      const rateLimited = await checkPublicRateLimit(db, request, 240);
      if (rateLimited) return rateLimited;

      if (action === 'public_tv') {
        const kegiatan = await getActiveKegiatan(db);
        if (!kegiatan) {
          return jsonResponse({ ok: true, kegiatan: null, pos_list: [], rows: [], active_sessions: [] });
        }

        const { results: posList } = await db.prepare('SELECT id, nama, urutan_tiebreaker FROM pos WHERE kegiatan_id = ? ORDER BY id ASC').bind(kegiatan.id).all();
        const { results: kontingens } = await db.prepare('SELECT id, kode, tingkat, jenis FROM kontingen WHERE kegiatan_id = ? ORDER BY kode ASC').bind(kegiatan.id).all();
        const { results: napRows } = await db.prepare('SELECT kontingen_id, pos_id, nilai_akhir, has_revisi FROM nilai_akhir_pos WHERE kegiatan_id = ?').bind(kegiatan.id).all();

        const napMap = {};
        for (const n of napRows || []) {
          const kid = Number(n.kontingen_id);
          if (!napMap[kid]) napMap[kid] = {};
          napMap[kid][Number(n.pos_id)] = {
            nilai_akhir: Number(n.nilai_akhir),
            has_revisi: Boolean(n.has_revisi),
          };
        }

        const { results: activeSessions } = await db.prepare(`
          SELECT DISTINCT k.kode AS kontingen_kode, sp.pos_id, p.nama AS pos_nama
          FROM sesi_penilaian sp
          JOIN kontingen k ON k.id = sp.kontingen_id
          JOIN pos p ON p.id = sp.pos_id
          WHERE sp.kegiatan_id = ? AND sp.status = 'berjalan'
          ORDER BY sp.id DESC
        `).bind(kegiatan.id).all();

        const activeMap = {};
        for (const as of activeSessions || []) {
          if (!activeMap[as.kontingen_kode]) activeMap[as.kontingen_kode] = {};
          activeMap[as.kontingen_kode][Number(as.pos_id)] = true;
        }

        const rows = (kontingens || []).map((k) => {
          const cells = {};
          for (const p of posList || []) {
            const pid = Number(p.id);
            const score = napMap[Number(k.id)]?.[pid] || null;
            cells[pid] = {
              nilai_akhir: score ? score.nilai_akhir : null,
              has_revisi: score ? score.has_revisi : false,
              sedang_dinilai: Boolean(activeMap[k.kode]?.[pid]),
            };
          }
          return { kode: k.kode, tingkat: k.tingkat, cells };
        });

        return jsonResponse({
          ok: true,
          kegiatan: { id: Number(kegiatan.id), tahun: Number(kegiatan.tahun), nama: kegiatan.nama },
          pos_list: posList || [],
          rows,
          active_sessions: activeSessions || [],
          server_time: nowIso(),
        });
      }

      if (action === 'public_nilai') {
        let kegId = Number(url.searchParams.get('kegiatan') || 0);
        if (kegId <= 0) {
          const act = await getActiveKegiatan(db);
          kegId = act ? Number(act.id) : 0;
        }
        const kode = (url.searchParams.get('kontingen') || '').trim().toUpperCase();
        const posId = Number(url.searchParams.get('pos') || 0);

        if (kegId <= 0 || !kode || posId <= 0) {
          return jsonError('Parameter kegiatan, kontingen, dan pos tidak valid.', 400);
        }

        const payload = await getReceiptPayload(db, kegId, kode, posId);
        if (!payload) {
          return jsonError('Data nilai untuk kontingen dan pos tersebut belum ditemukan.', 404);
        }

        const publicReceiptPdf = {
          kegiatan: payload.kegiatan,
          kontingen: {
            kode: payload.kontingen.kode,
            tingkat: payload.kontingen.tingkat,
            jenis: payload.kontingen.jenis,
          },
          pos: payload.pos,
          rubriks: payload.rubriks,
          juri_breakdown: payload.juri_breakdown.map((jb) => ({
            juri_urutan: jb.juri_urutan,
            juri_label: `Juri ${jb.juri_urutan}`,
            waktu_selesai: jb.waktu_selesai,
            timer_detik: jb.timer_detik,
            bidak: jb.bidak,
            total_juri: jb.total_juri,
            komponen_subtotals: jb.komponen_subtotals,
            rubrik_nilai: jb.rubrik_nilai,
          })),
          nilai_akhir: payload.nilai_akhir,
          total_timer: payload.total_timer,
          bidak: payload.bidak,
          has_revisi: payload.has_revisi,
        };

        return jsonResponse({
          ok: true,
          public_summary: {
            kegiatan_nama: payload.kegiatan.nama,
            kontingen_kode: payload.kontingen.kode,
            pos_nama: payload.pos.nama,
            nilai_akhir: payload.nilai_akhir,
            has_revisi: payload.has_revisi,
          },
          pdf_transcript: publicReceiptPdf,
        });
      }

      return jsonError('Endpoint publik tidak dikenal.', 404);
    }

    // Auth endpoints
    if (action === 'auth_me') {
      const user = await getOptionalAuth(env, request);
      const kegiatan = await getActiveKegiatan(db);
      return jsonResponse({ ok: true, user, kegiatan });
    }

    if (action === 'auth_login') {
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');

      if (!username || !password) {
        return jsonError('Username dan password wajib diisi.', 400);
      }

      const acc = await db.prepare('SELECT * FROM akun WHERE LOWER(username) = ? LIMIT 1').bind(username).first();
      if (!acc || !(await verifyPassword(password, acc.password_hash))) {
        return jsonError('Username atau password salah.', 401);
      }

      const cookie = await createSessionCookie(acc.id, env, request);
      return jsonResponse({
        ok: true,
        user: {
          id: Number(acc.id),
          username: acc.username,
          nama: acc.nama,
          peran: acc.peran,
          no_wa: acc.no_wa,
          wajib_ganti_password: Boolean(acc.wajib_ganti_password),
        },
      }, 200, { 'Set-Cookie': cookie });
    }

    if (action === 'auth_register_pembina') {
      const nama = String(body.nama || '').trim();
      const username = String(body.username || '').trim().toLowerCase();
      const wa = normalizeWa(body.no_wa || '');
      const password = String(body.password || '');

      if (!nama || !/^[a-z0-9_.-]{3,30}$/.test(username) || !wa || password.length < 6) {
        return jsonError('Nama, username (huruf/angka 3-30 karakter), nomor WhatsApp wajib, dan password minimal 6 karakter harus diisi.', 400);
      }

      const exists = await db.prepare('SELECT id FROM akun WHERE LOWER(username) = ?').bind(username).first();
      if (exists) {
        return jsonError('Username sudah terdaftar.', 400);
      }

      const pwHash = await hashPassword(password);
      const res = await db.prepare(
        "INSERT INTO akun (username, nama, peran, no_wa, password_hash, wajib_ganti_password, created_at) VALUES (?, ?, 'pembina', ?, ?, 0, ?)"
      ).bind(username, nama, wa, pwHash, nowIso()).run();
      const newId = Number(res.meta.last_row_id);

      const actor = { id: newId, nama, peran: 'pembina' };
      await writeLog(db, actor, 'pendaftaran_pembina', `Akun pembina baru mendaftar: ${nama} (@${username}, WA: ${wa}).`, `akun:${newId}`);

      const cookie = await createSessionCookie(newId, env, request);
      return jsonResponse({
        ok: true,
        user: {
          id: newId,
          username,
          nama,
          peran: 'pembina',
          no_wa: wa,
          wajib_ganti_password: false,
        },
      }, 200, { 'Set-Cookie': cookie });
    }

    if (action === 'auth_logout') {
      return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(request) });
    }

    if (action === 'auth_change_password') {
      const auth = await requireAuth(env, request);
      if (auth.error) return auth.error;
      const user = auth.user;

      const newPass = String(body.new_password || '');
      if (newPass.length < 6) {
        return jsonError('Password baru minimal 6 karakter.', 400);
      }

      const pwHash = await hashPassword(newPass);
      await db.prepare('UPDATE akun SET password_hash = ?, wajib_ganti_password = 0 WHERE id = ?').bind(pwHash, user.id).run();
      await writeLog(db, user, 'ganti_password', `Pengguna ${user.nama} (@${user.username}) mengganti password.`);
      return jsonResponse({ ok: true });
    }

    // All remaining endpoints require auth AND completed temporary password change
    const auth = await requireAuth(env, request);
    if (auth.error) return auth.error;
    const user = auth.user;

    if (user.wajib_ganti_password) {
      return jsonError('Anda wajib mengganti password sementara sebelum menggunakan sistem.', 403, { require_password_change: true });
    }

    if (action.startsWith('pembina_')) {
      if (user.peran !== 'pembina') return jsonError('Akses khusus pembina.', 403);
      return await handlePembinaAction(db, user, action, body);
    }
    if (action.startsWith('juri_')) {
      if (user.peran !== 'juri') return jsonError('Akses khusus juri.', 403);
      return await handleJuriAction(db, user, action, body, url);
    }
    if (action.startsWith('admin_')) {
      if (user.peran !== 'admin') return jsonError('Akses khusus admin.', 403);
      return await handleAdminAction(db, user, action, body, url);
    }

    return jsonError('Endpoint tidak ditemukan.', 404);
  } catch (err) {
    return jsonError(`Terjadi kesalahan server: ${err.message}`, 500);
  }
}
