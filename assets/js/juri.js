window.JUMBARA_JURI = (() => {
  const J = window.JUMBARA;
  const BLE = window.BLE_PRINTER;

  const CACHE_KEY = 'jumbara_juri_cache_v1';
  const DRAFT_KEY = 'jumbara_juri_draft_v1';
  const QUEUE_KEY = 'jumbara_juri_sync_queue_v1';

  const ROLE_OPTIONS = ['Pemimpin', 'Anggota', 'Narator', 'Pelaku', 'Penyuluh'];

  let state = {
    user: null,
    kegiatan: null,
    posList: [],
    pesertaCache: [],
    history: [],
    view: 'home', // home | session | receipt
    activeDraft: null,
    activeReceipt: null,
    reprintBadge: '',
    menuOpen: false,
    scannerStream: null,
    scannerRaf: null,
    timerInterval: null,
    syncing: false,
  };

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJson(key, val) {
    if (val === null || val === undefined) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(val));
    }
  }

  function getQueue() {
    return loadJson(QUEUE_KEY, []);
  }

  function setQueue(q) {
    saveJson(QUEUE_KEY, q);
  }

  function saveDraft() {
    saveJson(DRAFT_KEY, state.activeDraft);
  }

  function stopScanner() {
    if (state.scannerRaf) {
      cancelAnimationFrame(state.scannerRaf);
      state.scannerRaf = null;
    }
    if (state.scannerStream) {
      state.scannerStream.getTracks().forEach((t) => t.stop());
      state.scannerStream = null;
    }
  }

  function stopTimerLoop() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }

  async function syncPendingQueue(silent = false) {
    if (state.syncing || !navigator.onLine) return;
    const queue = getQueue();
    if (queue.length === 0) return;

    state.syncing = true;
    let syncedCount = 0;
    const remaining = [];

    for (const item of queue) {
      try {
        await J.apiFetch('juri_session_submit', { method: 'POST', body: item.payload });
        syncedCount++;
      } catch (err) {
        if (err.status && err.status >= 400 && err.status < 500) {
          // Validation / duplicate handled; notify if error
          J.toast(`Sinkronisasi ${item.kontingen_kode}: ${err.message}`, 'error');
        } else {
          remaining.push(item);
        }
      }
    }

    setQueue(remaining);
    state.syncing = false;
    if (syncedCount > 0) {
      if (!silent) J.toast(`${syncedCount} sesi penilaian berhasil disinkronkan ke server.`, 'success');
      await refreshBootstrap();
    }
    render();
  }

  async function refreshBootstrap() {
    try {
      const data = await J.apiFetch('juri_bootstrap');
      state.kegiatan = data.kegiatan;
      state.posList = data.pos_list || [];
      state.pesertaCache = data.peserta_cache || [];
      state.history = data.history || [];
      saveJson(CACHE_KEY, {
        userId: state.user.id,
        kegiatan: state.kegiatan,
        posList: state.posList,
        pesertaCache: state.pesertaCache,
        history: state.history,
      });
    } catch (err) {
      const cached = loadJson(CACHE_KEY, null);
      if (cached && cached.userId === state.user.id) {
        state.kegiatan = cached.kegiatan;
        state.posList = cached.posList || [];
        state.pesertaCache = cached.pesertaCache || [];
        state.history = cached.history || [];
        J.toast('Mode offline aktif — memakai data pos & peserta tersimpan.', 'warning');
      } else {
        J.toast(err.message, 'error');
      }
    }
  }

  function findPosById(posId) {
    return state.posList.find((p) => Number(p.id) === Number(posId)) || null;
  }

  function buildLocalOfflineReceipt(payload, kontingenInfo, pos) {
    const rubriks = pos.rubriks || [];
    let total = 0;
    const komponenSub = {};
    const rubrikNilai = rubriks.map((r) => {
      const found = (payload.scores || []).find((s) => Number(s.rubrik_id) === Number(r.id));
      const val = found ? Number(found.nilai) : 0;
      total += val;
      const komp = r.komponen || 'Umum';
      komponenSub[komp] = (komponenSub[komp] || 0) + val;
      return {
        rubrik_id: r.id,
        rubrik_nama: r.nama,
        komponen: komp,
        nilai_maksimal: r.nilai_maksimal,
        nilai: val,
      };
    });

    return {
      offline_pending: true,
      kegiatan: state.kegiatan || { id: 1, nama: 'Jumbara PMR' },
      kontingen: {
        id: kontingenInfo.kontingen_id,
        kode: kontingenInfo.kontingen_kode,
        sekolah_nama: kontingenInfo.sekolah_nama || '',
      },
      pos: {
        id: pos.id,
        nama: pos.nama,
        jumlah_juri: pos.jumlah_juri,
        cara_gabung: pos.cara_gabung,
        pakai_timer: !!pos.pakai_timer,
        pakai_bidak: !!pos.pakai_bidak,
      },
      rubriks,
      juri_breakdown: [{
        juri_urutan: 1,
        juri_nama: state.user.nama,
        timer_detik: payload.timer_detik,
        bidak: payload.bidak,
        total_juri: Math.round(total * 100) / 100,
        komponen_subtotals: komponenSub,
        rubrik_nilai: rubrikNilai,
      }],
      nilai_akhir: Math.round(total * 100) / 100,
      total_timer: payload.timer_detik,
      bidak: payload.bidak,
      has_revisi: false,
    };
  }

  async function mount(rootEl, user) {
    state.user = user;
    state.root = rootEl;

    // Restore saved draft if belonging to this judge
    const savedDraft = loadJson(DRAFT_KEY, null);
    if (savedDraft && savedDraft.juri_id === user.id) {
      state.activeDraft = savedDraft;
    }

    await refreshBootstrap();
    await syncPendingQueue(true);

    window.addEventListener('online', () => {
      syncPendingQueue(false);
      render();
    });
    window.addEventListener('offline', () => render());

    // Resume directly into draft if one exists
    if (state.activeDraft) {
      state.view = 'session';
    } else {
      state.view = 'home';
    }
    render();
  }

  function startNewSession(posId) {
    const pos = findPosById(posId);
    if (!pos) return;
    const scores = {};
    (pos.rubriks || []).forEach((r) => { scores[r.id] = 0; });

    state.activeDraft = {
      juri_id: state.user.id,
      client_session_uuid: J.uuidv4(),
      pos_id: pos.id,
      kontingen: null, // determined from first QR scan
      attendees: [],   // [{ peserta_id, kode_peserta, nama, peran_di_pos }]
      scores,
      timer_detik: 0,
      timer_running: false,
      timer_started_at: null,
      bidak: 0,
      updated_at: new Date().toISOString(),
    };
    saveDraft();
    state.view = 'session';
    render();
  }

  async function handleScannedCode(rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code || !state.activeDraft) return;

    // If URL was somehow passed, extract query or fallback to raw
    let peserta = state.pesertaCache.find((p) => p.kode_peserta.toUpperCase() === code) || null;
    if (!peserta && navigator.onLine) {
      try {
        const res = await J.apiFetch('juri_lookup_peserta', {
          params: { pos_id: state.activeDraft.pos_id, kode: code },
        });
        peserta = res.peserta;
      } catch (err) {
        J.toast(err.message, 'error');
        return;
      }
    }

    if (!peserta) {
      J.toast(`Kode peserta "${code}" tidak ditemukan.`, 'error');
      return;
    }

    const draft = state.activeDraft;
    if (!draft.kontingen) {
      draft.kontingen = {
        kontingen_id: peserta.kontingen_id,
        kontingen_kode: peserta.kontingen_kode,
        tingkat: peserta.tingkat,
        jenis: peserta.jenis,
        sekolah_nama: peserta.sekolah_nama,
      };
      // Notify server so TV live banner shows this kontingen
      if (navigator.onLine) {
        J.apiFetch('juri_session_start', {
          method: 'POST',
          body: {
            pos_id: draft.pos_id,
            kontingen_id: peserta.kontingen_id,
            client_session_uuid: draft.client_session_uuid,
          },
        }).catch(() => {});
      }
    } else if (Number(draft.kontingen.kontingen_id) !== Number(peserta.kontingen_id)) {
      J.toast(`Ditolak! ${peserta.kode_peserta} dari kontingen ${peserta.kontingen_kode}, sesi ini untuk ${draft.kontingen.kontingen_kode}.`, 'error');
      return;
    }

    if (draft.attendees.some((a) => Number(a.peserta_id) === Number(peserta.id))) {
      J.toast(`Peserta ${peserta.kode_peserta} sudah ada di daftar hadir sesi.`, 'warning');
      return;
    }

    draft.attendees.push({
      peserta_id: peserta.id,
      kode_peserta: peserta.kode_peserta,
      nama: peserta.nama,
      peran_di_pos: draft.attendees.length === 0 ? 'Pemimpin' : 'Anggota',
    });
    saveDraft();
    J.toast(`Hadir: ${peserta.kode_peserta} (${peserta.nama})`, 'success');
    render();
  }

  async function finishSession() {
    const draft = state.activeDraft;
    const pos = findPosById(draft.pos_id);
    if (!draft || !pos) return;

    if (!draft.kontingen || draft.attendees.length === 0) {
      J.toast('Pindai minimal 1 kartu peserta sebelum menyelesaikan sesi.', 'error');
      return;
    }

    stopTimerLoop();
    stopScanner();

    const finalTimer = draft.timer_running && draft.timer_started_at
      ? draft.timer_detik + Math.floor((Date.now() - draft.timer_started_at) / 1000)
      : draft.timer_detik;

    const payload = {
      client_session_uuid: draft.client_session_uuid,
      pos_id: draft.pos_id,
      kontingen_id: draft.kontingen.kontingen_id,
      timer_detik: Math.max(0, Math.floor(finalTimer)),
      bidak: Number(draft.bidak) || 0,
      peserta_roles: draft.attendees.map((a) => ({
        peserta_id: a.peserta_id,
        peran_di_pos: a.peran_di_pos,
      })),
      scores: (pos.rubriks || []).map((r) => ({
        uid_unik: `${draft.client_session_uuid}-r${r.id}`,
        rubrik_id: r.id,
        nilai: Number(draft.scores[r.id] || 0),
      })),
    };

    let receipt = null;
    if (navigator.onLine) {
      try {
        const res = await J.apiFetch('juri_session_submit', { method: 'POST', body: payload });
        receipt = res.receipt;
        J.toast('Penilaian tersimpan ke server!', 'success');
        await refreshBootstrap();
      } catch (err) {
        if (err.status && err.status >= 400 && err.status < 500) {
          J.toast(err.message, 'error');
          return;
        }
        // Network failure -> queue locally
        const q = getQueue();
        q.push({ kontingen_kode: draft.kontingen.kontingen_kode, payload, queued_at: new Date().toISOString() });
        setQueue(q);
        receipt = buildLocalOfflineReceipt(payload, draft.kontingen, pos);
        J.toast('Koneksi terputus — nilai disimpan lokal & siap cetak struk.', 'warning');
      }
    } else {
      const q = getQueue();
      q.push({ kontingen_kode: draft.kontingen.kontingen_kode, payload, queued_at: new Date().toISOString() });
      setQueue(q);
      receipt = buildLocalOfflineReceipt(payload, draft.kontingen, pos);
      J.toast('Offline — nilai disimpan di perangkat & otomatis dikirim saat online.', 'warning');
    }

    state.activeDraft = null;
    saveDraft();
    state.activeReceipt = receipt;
    state.reprintBadge = '';
    state.view = 'receipt';
    render();
  }

  function showExitConfirmModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-card">
        <h3 style="margin-bottom:8px;">Keluar dari Sesi Penilaian?</h3>
        <p class="text-muted" style="margin:0 0 18px;">
          Draf sesi ini tersimpan otomatis di perangkat Anda. Anda dapat keluar sementara dan melanjutkan lagi nanti tanpa kehilangan isian.
        </p>
        <div class="row-gap" style="justify-content:flex-end;">
          <button class="btn btn-secondary" id="m-stay">Tetap di Sesi</button>
          <button class="btn btn-primary" id="m-leave">Keluar Sementara</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#m-stay').onclick = () => modal.remove();
    modal.querySelector('#m-leave').onclick = () => {
      stopScanner();
      stopTimerLoop();
      modal.remove();
      state.view = 'home';
      render();
    };
  }

  function showCancelTwoStepModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-card">
        <span class="badge badge-red" style="margin-bottom:10px;">Langkah 1 dari 2 · Batal Sesi</span>
        <h3 style="margin-bottom:8px;">Batalkan Sesi Penilaian Ini?</h3>
        <p style="margin:0 0 18px;">
          Jika dibatalkan, <strong>semua draf kehadiran dan nilai yang sudah diisi akan dihapus permanen</strong> dan tidak ada yang disimpan ke server.
        </p>
        <div class="row-gap" style="justify-content:flex-end;">
          <button class="btn btn-secondary" id="c-no">Kembali</button>
          <button class="btn btn-warning" id="c-next">Lanjut Konfirmasi</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#c-no').onclick = () => modal.remove();
    modal.querySelector('#c-next').onclick = () => {
      modal.innerHTML = `
        <div class="modal-card">
          <span class="badge badge-solid-red" style="margin-bottom:10px;">Langkah 2 dari 2 · Konfirmasi Akhir</span>
          <h3 style="margin-bottom:8px;">Hapus Seluruh Draf Sesi?</h3>
          <p class="text-muted" style="margin:0 0 18px;">
            Tindakan ini tidak dapat dibatalkan. Semua data peserta hadir, timer, bidak, dan nilai rubrik di sesi ini akan hilang.
          </p>
          <div class="row-gap" style="justify-content:flex-end;">
            <button class="btn btn-secondary" id="c-back">Jangan Batalkan</button>
            <button class="btn btn-danger" id="c-confirm">Ya, Hapus &amp; Batalkan Sesi</button>
          </div>
        </div>
      `;
      modal.querySelector('#c-back').onclick = () => modal.remove();
      modal.querySelector('#c-confirm').onclick = async () => {
        const uuid = state.activeDraft ? state.activeDraft.client_session_uuid : '';
        stopScanner();
        stopTimerLoop();
        state.activeDraft = null;
        saveDraft();
        modal.remove();
        if (uuid && navigator.onLine) {
          J.apiFetch('juri_session_cancel', { method: 'POST', body: { client_session_uuid: uuid } }).catch(() => {});
        }
        J.toast('Sesi dibatalkan dan draf dihapus.', 'info');
        state.view = 'home';
        render();
      };
    };
  }

  async function openCorrectionModal(sesiId) {
    try {
      const detail = await J.apiFetch('juri_get_session_detail', { params: { sesi_id: sesiId } });
      const s = detail.sesi;
      const scores = detail.scores || [];
      const historyKoreksi = detail.koreksi || [];

      const modal = document.createElement('div');
      modal.className = 'modal-backdrop';
      modal.innerHTML = `
        <div class="modal-card">
          <div class="row-between" style="margin-bottom:12px;">
            <div>
              <h3>Ajukan Koreksi Nilai</h3>
              <div class="text-muted" style="font-size:0.85rem;">${J.esc(s.kontingen_kode)} · ${J.esc(s.pos_nama)}</div>
            </div>
            <button class="btn btn-ghost btn-sm" id="kr-close">Tutup</button>
          </div>
          <form id="kr-form">
            ${scores.map((sc) => `
              <div class="field">
                <label>${J.esc(sc.nama)} (Maks: ${J.formatNum(sc.nilai_maksimal)})</label>
                <input type="number" step="0.5" min="0" max="${sc.nilai_maksimal}" class="input kr-score" data-rubrik="${sc.rubrik_id}" value="${sc.nilai}" required />
              </div>
            `).join('')}
            ${Number(s.pakai_timer) ? `
              <div class="field">
                <label>Timer (detik)</label>
                <input type="number" min="0" class="input" id="kr-timer" value="${s.timer_detik}" />
              </div>
            ` : ''}
            ${Number(s.pakai_bidak) ? `
              <div class="field">
                <label>Bidak</label>
                <input type="number" step="0.5" class="input" id="kr-bidak" value="${s.bidak}" />
              </div>
            ` : ''}
            <div class="field">
              <label>Alasan Koreksi (Wajib)</label>
              <textarea class="textarea" id="kr-alasan" placeholder="Jelaskan alasan pengajuan perubahan nilai..." required></textarea>
            </div>
            <button type="submit" class="btn btn-primary btn-block">Kirim Pengajuan ke Admin</button>
          </form>
          ${historyKoreksi.length > 0 ? `
            <div style="margin-top:16px; border-top:1px solid var(--pmi-gray-lighter); padding-top:12px;">
              <strong style="font-size:0.85rem;">Riwayat Koreksi Sesi Ini</strong>
              ${historyKoreksi.map((k) => `
                <div style="font-size:0.82rem; padding:6px 0; border-bottom:1px solid #eee;">
                  <span class="badge ${k.status === 'disetujui' ? 'badge-green' : k.status === 'ditolak' ? 'badge-red' : 'badge-orange'}">${J.esc(k.status.toUpperCase())}</span>
                  ${J.formatNum(k.nilai_lama)} → ${J.formatNum(k.nilai_baru)} · ${J.esc(k.alasan)}
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      `;
      document.body.appendChild(modal);
      modal.querySelector('#kr-close').onclick = () => modal.remove();
      modal.querySelector('#kr-form').onsubmit = async (e) => {
        e.preventDefault();
        const newScores = Array.from(modal.querySelectorAll('.kr-score')).map((inp) => ({
          rubrik_id: Number(inp.dataset.rubrik),
          nilai: Number(inp.value),
        }));
        const timerDetik = modal.querySelector('#kr-timer') ? Number(modal.querySelector('#kr-timer').value) : Number(s.timer_detik);
        const bidak = modal.querySelector('#kr-bidak') ? Number(modal.querySelector('#kr-bidak').value) : Number(s.bidak);
        const alasan = modal.querySelector('#kr-alasan').value.trim();

        try {
          await J.apiFetch('juri_request_correction', {
            method: 'POST',
            body: { sesi_id: sesiId, scores: newScores, timer_detik: timerDetik, bidak, alasan },
          });
          J.toast('Pengajuan koreksi dikirim. Menunggu persetujuan Admin.', 'success');
          modal.remove();
          await refreshBootstrap();
          render();
        } catch (err) {
          J.toast(err.message, 'error');
        }
      };
    } catch (err) {
      J.toast(err.message, 'error');
    }
  }

  function renderStatusBar() {
    const queue = getQueue();
    const online = navigator.onLine;
    const ble = BLE.getStatus();
    return `
      <div class="row-between" style="margin-bottom:12px; gap:8px;">
        <div class="row-gap">
          <span class="badge ${online ? 'badge-green' : 'badge-orange'}">${online ? '● Online' : '● Offline'}</span>
          ${queue.length > 0 ? `
            <button id="btn-sync-now" class="btn btn-sm btn-light-red">
              Antrean Sync (${queue.length})
            </button>
          ` : ''}
        </div>
        <button id="btn-ble-connect" class="btn btn-sm ${ble.connected ? 'btn-success' : 'btn-secondary'}">
          ${ble.connected ? `BLE: ${J.esc(ble.name)}` : 'Printer BLE'}
        </button>
      </div>
    `;
  }

  function bindStatusBarEvents() {
    const syncBtn = state.root.querySelector('#btn-sync-now');
    if (syncBtn) syncBtn.onclick = () => syncPendingQueue(false);

    const bleBtn = state.root.querySelector('#btn-ble-connect');
    if (bleBtn) {
      bleBtn.onclick = async () => {
        try {
          const st = await BLE.connect();
          J.toast(`Terhubung ke ${st.name}`, 'success');
          render();
        } catch (err) {
          J.toast(err.message, 'error');
        }
      };
    }
  }

  function renderHome() {
    const draft = state.activeDraft;
    const draftPos = draft ? findPosById(draft.pos_id) : null;

    state.root.innerHTML = `
      <div class="juri-shell">
        ${renderStatusBar()}

        ${draft && draftPos ? `
          <div class="card card-red-tint" style="margin-bottom:14px;">
            <div class="row-between">
              <div>
                <span class="badge badge-solid-red">Draf Tersimpan</span>
                <h3 style="margin-top:6px;">${J.esc(draftPos.nama)}</h3>
                <div class="text-muted" style="font-size:0.86rem;">
                  ${draft.kontingen ? `Kontingen ${J.esc(draft.kontingen.kontingen_kode)} · ` : ''}${draft.attendees.length} peserta hadir
                </div>
              </div>
              <button id="btn-resume-draft" class="btn btn-primary">Lanjutkan</button>
            </div>
          </div>
        ` : ''}

        <div style="margin-bottom:16px;">
          <h2 style="font-size:1.15rem; margin-bottom:10px;">Pos Tugas Anda</h2>
          ${state.posList.length === 0 ? `
            <div class="card">Belum ada pos yang ditugaskan oleh Admin untuk akun Anda.</div>
          ` : `
            <div class="grid" style="gap:12px;">
              ${state.posList.map((p) => `
                <div class="card">
                  <div class="row-between" style="margin-bottom:8px;">
                    <h3 style="font-size:1.05rem;">${J.esc(p.nama)}</h3>
                    <span class="badge badge-red">${p.jumlah_juri} Juri · ${p.cara_gabung === 'jumlah' ? 'Jumlah' : 'Rata-rata'}</span>
                  </div>
                  <div class="row-gap text-muted" style="font-size:0.82rem; margin-bottom:12px;">
                    <span>${(p.rubriks || []).length} Rubrik</span>
                    ${p.pakai_timer ? '<span>· Pakai Timer</span>' : ''}
                    ${p.pakai_bidak ? '<span>· Pakai Bidak</span>' : ''}
                  </div>
                  <button class="btn btn-primary btn-block btn-start-pos" data-pos="${p.id}">
                    Mulai Sesi Penilaian
                  </button>
                </div>
              `).join('')}
            </div>
          `}
        </div>

        <div>
          <h2 style="font-size:1.15rem; margin-bottom:10px;">Riwayat Penilaian Anda</h2>
          ${state.history.length === 0 ? `
            <div class="card text-muted">Belum ada sesi selesai.</div>
          ` : `
            <div class="grid" style="gap:10px;">
              ${state.history.map((h) => `
                <div class="card" style="padding:12px 14px;">
                  <div class="row-between" style="margin-bottom:6px;">
                    <div>
                      <span class="mono fw-bold" style="font-size:1rem;">${J.esc(h.kontingen_kode)}</span>
                      <span class="text-muted" style="font-size:0.84rem;"> · ${J.esc(h.pos_nama)}</span>
                    </div>
                    <div class="fw-bold text-red" style="font-size:1.05rem;">${J.formatNum(h.total_juri)}</div>
                  </div>
                  <div class="row-between" style="font-size:0.8rem; color:var(--pmi-gray); margin-bottom:10px;">
                    <span>${J.esc(h.sekolah_nama)}</span>
                    <span>
                      ${Number(h.has_revisi) ? '<span class="badge badge-orange">REVISI</span>' : ''}
                      ${h.koreksi_terakhir_status === 'diajukan' ? '<span class="badge badge-purple">Menunggu Koreksi</span>' : ''}
                    </span>
                  </div>
                  <div class="row-gap">
                    <button class="btn btn-secondary btn-sm btn-reprint" data-sesi="${h.id}" style="flex:1;">Cetak Ulang Struk</button>
                    <button class="btn btn-light-red btn-sm btn-correct" data-sesi="${h.id}" style="flex:1;">Ajukan Koreksi</button>
                  </div>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      </div>
    `;

    bindStatusBarEvents();

    const resumeBtn = state.root.querySelector('#btn-resume-draft');
    if (resumeBtn) {
      resumeBtn.onclick = () => {
        state.view = 'session';
        render();
      };
    }

    state.root.querySelectorAll('.btn-start-pos').forEach((btn) => {
      btn.onclick = () => {
        const pid = Number(btn.dataset.pos);
        if (state.activeDraft && Number(state.activeDraft.pos_id) !== pid) {
          J.toast('Selesaikan atau batalkan draf sesi yang sedang aktif terlebih dahulu.', 'warning');
          state.view = 'session';
          render();
          return;
        }
        if (state.activeDraft && Number(state.activeDraft.pos_id) === pid) {
          state.view = 'session';
          render();
          return;
        }
        startNewSession(pid);
      };
    });

    state.root.querySelectorAll('.btn-reprint').forEach((btn) => {
      btn.onclick = async () => {
        try {
          const res = await J.apiFetch('juri_reprint_receipt', {
            method: 'POST',
            body: { sesi_id: Number(btn.dataset.sesi) },
          });
          state.activeReceipt = res.receipt;
          state.reprintBadge = res.reprint_badge;
          state.view = 'receipt';
          render();
        } catch (err) {
          J.toast(err.message, 'error');
        }
      };
    });

    state.root.querySelectorAll('.btn-correct').forEach((btn) => {
      btn.onclick = () => openCorrectionModal(Number(btn.dataset.sesi));
    });
  }

  function renderSession() {
    const draft = state.activeDraft;
    const pos = draft ? findPosById(draft.pos_id) : null;
    if (!draft || !pos) {
      state.view = 'home';
      render();
      return;
    }

    const rubriks = pos.rubriks || [];
    let totalScore = 0;
    const kompSub = {};
    rubriks.forEach((r) => {
      const val = Number(draft.scores[r.id] || 0);
      totalScore += val;
      const k = r.komponen || 'Umum';
      kompSub[k] = (kompSub[k] || 0) + val;
    });

    const elapsedSec = draft.timer_running && draft.timer_started_at
      ? draft.timer_detik + Math.floor((Date.now() - draft.timer_started_at) / 1000)
      : draft.timer_detik;

    state.root.innerHTML = `
      <div class="juri-shell">
        <div class="row-between" style="margin-bottom:10px;">
          <button id="btn-session-back" class="btn btn-secondary btn-sm">← Keluar</button>
          <div style="text-align:center; flex:1;">
            <div class="fw-bold" style="font-size:0.95rem;">${J.esc(pos.nama)}</div>
            <div class="text-muted" style="font-size:0.75rem;">Draf tersimpan otomatis</div>
          </div>
          <div class="menu-dropdown">
            <button id="btn-overflow" class="btn btn-secondary btn-sm" aria-label="Menu sesi">•••</button>
            <div id="overflow-menu" class="menu-popover ${state.menuOpen ? '' : 'hidden'}">
              <button id="btn-cancel-session" class="btn btn-ghost btn-block" style="justify-content:flex-start; color:#b91c1c;">
                Batal Sesi (Hapus Draf)
              </button>
            </div>
          </div>
        </div>

        ${renderStatusBar()}

        <!-- Kontingen Locked Banner -->
        <div class="card ${draft.kontingen ? 'card-red-tint' : ''}" style="margin-bottom:12px;">
          ${draft.kontingen ? `
            <div class="row-between">
              <div>
                <div style="font-size:0.75rem; text-transform:uppercase; font-weight:700; color:var(--pmi-red-dark);">Kontingen Sesi</div>
                <div class="mono fw-bold" style="font-size:1.35rem;">${J.esc(draft.kontingen.kontingen_kode)}</div>
                <div style="font-size:0.85rem;">${J.esc(draft.kontingen.sekolah_nama)} · ${J.esc(draft.kontingen.tingkat)}</div>
              </div>
              <span class="badge badge-red">${draft.attendees.length} Hadir</span>
            </div>
          ` : `
            <div class="fw-bold" style="margin-bottom:4px;">1. Pindai QR Kartu Peserta Pertama</div>
            <div class="text-muted" style="font-size:0.85rem;">Kontingen otomatis terdeteksi dari kode peserta.</div>
          `}
        </div>

        <!-- QR Camera Scanner + Manual Fallback -->
        <div class="card" style="margin-bottom:12px;">
          <div class="row-between" style="margin-bottom:10px;">
            <strong>Presensi Peserta (QR Kamera)</strong>
            <button id="btn-toggle-cam" class="btn btn-sm ${state.scannerStream ? 'btn-danger' : 'btn-primary'}">
              ${state.scannerStream ? 'Tutup Kamera' : 'Buka Kamera QR'}
            </button>
          </div>

          <div id="cam-wrap" class="${state.scannerStream ? '' : 'hidden'}" style="margin-bottom:10px;">
            <div class="scanner-box">
              <video id="qr-video" playsinline muted></video>
              <div class="scanner-reticle"></div>
            </div>
          </div>

          <form id="manual-scan-form" class="row-gap" style="margin-bottom:10px;">
            <input id="manual-kode" class="input mono" style="flex:1; text-transform:uppercase;" placeholder="Ketik kode peserta (mis. MU00101)" />
            <button type="submit" class="btn btn-secondary">Tambah</button>
          </form>

          ${draft.attendees.length > 0 ? `
            <div class="grid" style="gap:8px;">
              ${draft.attendees.map((a, idx) => `
                <div style="border:1px solid var(--pmi-gray-lighter); border-radius:8px; padding:8px 10px;">
                  <div class="row-between" style="margin-bottom:6px;">
                    <div>
                      <span class="mono fw-bold">${J.esc(a.kode_peserta)}</span>
                      <span style="font-size:0.9rem;"> · ${J.esc(a.nama)}</span>
                    </div>
                    <button class="btn btn-ghost btn-sm btn-rem-att" data-idx="${idx}" style="color:#b91c1c; min-height:30px; padding:2px 8px;">Hapus</button>
                  </div>
                  <div class="row-gap">
                    <select class="select sel-role" data-idx="${idx}" style="min-height:36px; padding:4px 8px; font-size:0.86rem;">
                      ${ROLE_OPTIONS.map((r) => `<option value="${r}" ${a.peran_di_pos === r ? 'selected' : ''}>${r}</option>`).join('')}
                      ${!ROLE_OPTIONS.includes(a.peran_di_pos) ? `<option value="${J.esc(a.peran_di_pos)}" selected>${J.esc(a.peran_di_pos)}</option>` : ''}
                    </select>
                  </div>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>

        <!-- Timer & Bidak -->
        ${(pos.pakai_timer || pos.pakai_bidak) ? `
          <div class="card" style="margin-bottom:12px;">
            ${pos.pakai_timer ? `
              <div class="row-between" style="${pos.pakai_bidak ? 'margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid var(--pmi-gray-lighter);' : ''}">
                <div>
                  <div class="text-muted" style="font-size:0.78rem; font-weight:700;">TIMER POS</div>
                  <div id="timer-display" class="mono fw-bold" style="font-size:1.7rem; color:var(--pmi-dark);">${J.formatTimer(elapsedSec)}</div>
                </div>
                <div class="row-gap">
                  <button id="btn-timer-toggle" class="btn btn-sm ${draft.timer_running ? 'btn-warning' : 'btn-success'}">
                    ${draft.timer_running ? 'Jeda' : 'Mulai'}
                  </button>
                  <button id="btn-timer-reset" class="btn btn-sm btn-secondary">Reset</button>
                </div>
              </div>
            ` : ''}
            ${pos.pakai_bidak ? `
              <div class="row-between">
                <div>
                  <div class="text-muted" style="font-size:0.78rem; font-weight:700;">BIDAK</div>
                  <div style="font-size:0.82rem;">Jumlah bidak kontingen</div>
                </div>
                <div class="row-gap">
                  <button id="btn-bidak-minus" class="btn btn-secondary btn-sm" style="min-width:44px;">-</button>
                  <input id="inp-bidak" type="number" step="0.5" class="input" style="width:82px; text-align:center;" value="${draft.bidak}" />
                  <button id="btn-bidak-plus" class="btn btn-secondary btn-sm" style="min-width:44px;">+</button>
                </div>
              </div>
            ` : ''}
          </div>
        ` : ''}

        <!-- Rubric Scoring Cards -->
        <div class="grid" style="gap:10px;">
          ${rubriks.map((r, i) => {
            const val = Number(draft.scores[r.id] || 0);
            const max = Number(r.nilai_maksimal);
            return `
              <div class="card">
                <div class="row-between" style="margin-bottom:8px;">
                  <div style="flex:1;">
                    <div class="row-gap" style="margin-bottom:3px;">
                      <span class="badge badge-gray">#${i + 1}</span>
                      ${r.komponen && r.komponen !== 'Umum' ? `<span class="badge ${r.komponen === 'Teori' ? 'badge-purple' : 'badge-red'}">${J.esc(r.komponen)}</span>` : ''}
                    </div>
                    <div class="fw-bold" style="font-size:0.98rem;">${J.esc(r.nama)}</div>
                  </div>
                  <div class="text-muted" style="font-size:0.82rem;">Maks: <strong>${J.formatNum(max)}</strong></div>
                </div>

                <div class="row-gap" style="margin-bottom:8px;">
                  <button class="btn btn-secondary btn-sm btn-step" data-rubrik="${r.id}" data-delta="-1" style="min-width:44px;">-1</button>
                  <input type="number" step="0.5" min="0" max="${max}" class="input inp-rubrik fw-bold" data-rubrik="${r.id}" data-max="${max}" value="${val}" style="flex:1; text-align:center; font-size:1.15rem;" />
                  <button class="btn btn-secondary btn-sm btn-step" data-rubrik="${r.id}" data-delta="1" style="min-width:44px;">+1</button>
                </div>

                <div class="row-gap">
                  ${[0, 0.5, 0.75, 1].map((ratio) => {
                    const preset = Math.round(max * ratio * 10) / 10;
                    return `<button class="btn btn-sm btn-light-red btn-preset" data-rubrik="${r.id}" data-val="${preset}" style="flex:1; min-height:34px; font-size:0.8rem;">${J.formatNum(preset)}</button>`;
                  }).join('')}
                </div>
              </div>
            `;
          }).join('')}
        </div>

        ${(kompSub.Teori !== undefined || kompSub.Praktik !== undefined) ? `
          <div class="card" style="margin-top:12px;">
            <div class="row-between" style="font-size:0.9rem;">
              ${kompSub.Teori !== undefined ? `<span>Subtotal Teori: <strong>${J.formatNum(kompSub.Teori)}</strong></span>` : ''}
              ${kompSub.Praktik !== undefined ? `<span>Subtotal Praktik: <strong>${J.formatNum(kompSub.Praktik)}</strong></span>` : ''}
            </div>
          </div>
        ` : ''}
      </div>

      <div class="juri-sticky-bottom">
        <div class="juri-sticky-bottom-inner">
          <div>
            <div style="font-size:0.74rem; color:var(--pmi-gray); font-weight:700;">TOTAL NILAI</div>
            <div id="live-total" class="fw-bold text-red" style="font-size:1.45rem; line-height:1.1;">${J.formatNum(totalScore)}</div>
          </div>
          <button id="btn-finish-session" class="btn btn-primary btn-lg" style="min-width:190px;">
            Selesai &amp; Struk
          </button>
        </div>
      </div>
    `;

    bindStatusBarEvents();

    state.root.querySelector('#btn-session-back').onclick = showExitConfirmModal;
    state.root.querySelector('#btn-overflow').onclick = (e) => {
      e.stopPropagation();
      state.menuOpen = !state.menuOpen;
      state.root.querySelector('#overflow-menu').classList.toggle('hidden', !state.menuOpen);
    };
    state.root.querySelector('#btn-cancel-session').onclick = () => {
      state.menuOpen = false;
      showCancelTwoStepModal();
    };

    state.root.querySelector('#manual-scan-form').onsubmit = (e) => {
      e.preventDefault();
      const inp = state.root.querySelector('#manual-kode');
      handleScannedCode(inp.value);
      inp.value = '';
    };

    state.root.querySelector('#btn-toggle-cam').onclick = async () => {
      if (state.scannerStream) {
        stopScanner();
        render();
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        J.toast('Kamera browser membutuhkan HTTPS atau localhost.', 'error');
        return;
      }
      try {
        state.scannerStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        state.root.querySelector('#cam-wrap').classList.remove('hidden');
        const video = state.root.querySelector('#qr-video');
        video.srcObject = state.scannerStream;
        await video.play();
        state.root.querySelector('#btn-toggle-cam').textContent = 'Tutup Kamera';
        state.root.querySelector('#btn-toggle-cam').className = 'btn btn-sm btn-danger';

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        let lastCode = '';
        let lastTime = 0;

        const tick = () => {
          if (!state.scannerStream) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const qr = window.jsQR ? window.jsQR(imgData.data, imgData.width, imgData.height) : null;
            if (qr && qr.data) {
              const now = Date.now();
              if (qr.data !== lastCode || now - lastTime > 2500) {
                lastCode = qr.data;
                lastTime = now;
                handleScannedCode(qr.data);
              }
            }
          }
          state.scannerRaf = requestAnimationFrame(tick);
        };
        state.scannerRaf = requestAnimationFrame(tick);
      } catch (err) {
        J.toast('Gagal mengakses kamera: ' + err.message, 'error');
      }
    };

    state.root.querySelectorAll('.btn-rem-att').forEach((btn) => {
      btn.onclick = () => {
        draft.attendees.splice(Number(btn.dataset.idx), 1);
        if (draft.attendees.length === 0) draft.kontingen = null;
        saveDraft();
        render();
      };
    });

    state.root.querySelectorAll('.sel-role').forEach((sel) => {
      sel.onchange = () => {
        draft.attendees[Number(sel.dataset.idx)].peran_di_pos = sel.value;
        saveDraft();
      };
    });

    // Timer controls
    stopTimerLoop();
    if (pos.pakai_timer) {
      if (draft.timer_running) {
        state.timerInterval = setInterval(() => {
          const disp = document.getElementById('timer-display');
          if (disp && state.activeDraft) {
            const cur = state.activeDraft.timer_detik + Math.floor((Date.now() - state.activeDraft.timer_started_at) / 1000);
            disp.textContent = J.formatTimer(cur);
          }
        }, 500);
      }
      const btnToggle = state.root.querySelector('#btn-timer-toggle');
      if (btnToggle) {
        btnToggle.onclick = () => {
          if (draft.timer_running) {
            draft.timer_detik += Math.floor((Date.now() - draft.timer_started_at) / 1000);
            draft.timer_running = false;
            draft.timer_started_at = null;
          } else {
            draft.timer_running = true;
            draft.timer_started_at = Date.now();
          }
          saveDraft();
          render();
        };
      }
      const btnReset = state.root.querySelector('#btn-timer-reset');
      if (btnReset) {
        btnReset.onclick = () => {
          draft.timer_detik = 0;
          draft.timer_running = false;
          draft.timer_started_at = null;
          saveDraft();
          render();
        };
      }
    }

    // Bidak controls
    if (pos.pakai_bidak) {
      const inpB = state.root.querySelector('#inp-bidak');
      state.root.querySelector('#btn-bidak-minus').onclick = () => {
        draft.bidak = Math.max(0, (Number(draft.bidak) || 0) - 1);
        inpB.value = draft.bidak;
        saveDraft();
      };
      state.root.querySelector('#btn-bidak-plus').onclick = () => {
        draft.bidak = (Number(draft.bidak) || 0) + 1;
        inpB.value = draft.bidak;
        saveDraft();
      };
      inpB.onchange = () => {
        draft.bidak = Math.max(0, Number(inpB.value) || 0);
        saveDraft();
      };
    }

    // Score controls
    const updateRubrikVal = (rid, val, max) => {
      const clamped = Math.max(0, Math.min(max, Number(val) || 0));
      draft.scores[rid] = clamped;
      saveDraft();
      const inp = state.root.querySelector(`.inp-rubrik[data-rubrik="${rid}"]`);
      if (inp) inp.value = clamped;
      let sum = 0;
      rubriks.forEach((r) => { sum += Number(draft.scores[r.id] || 0); });
      const liveTot = document.getElementById('live-total');
      if (liveTot) liveTot.textContent = J.formatNum(sum);
    };

    state.root.querySelectorAll('.inp-rubrik').forEach((inp) => {
      inp.oninput = () => updateRubrikVal(inp.dataset.rubrik, inp.value, Number(inp.dataset.max));
    });
    state.root.querySelectorAll('.btn-step').forEach((btn) => {
      btn.onclick = () => {
        const rid = btn.dataset.rubrik;
        const r = rubriks.find((x) => Number(x.id) === Number(rid));
        updateRubrikVal(rid, Number(draft.scores[rid] || 0) + Number(btn.dataset.delta), Number(r.nilai_maksimal));
      };
    });
    state.root.querySelectorAll('.btn-preset').forEach((btn) => {
      btn.onclick = () => {
        const rid = btn.dataset.rubrik;
        const r = rubriks.find((x) => Number(x.id) === Number(rid));
        updateRubrikVal(rid, Number(btn.dataset.val), Number(r.nilai_maksimal));
      };
    });

    state.root.querySelector('#btn-finish-session').onclick = finishSession;
  }

  function renderReceipt() {
    const r = state.activeReceipt;
    if (!r) {
      state.view = 'home';
      render();
      return;
    }

    const qrLink = `${window.location.origin}${window.location.pathname.replace(/[^/]+$/, '')}publik.html?kegiatan=${r.kegiatan.id}&kontingen=${encodeURIComponent(r.kontingen.kode)}&pos=${r.pos.id}`;
    const qrImg = J.makeQrDataUrl(qrLink, 4, 2);
    const judges = r.juri_breakdown || [];
    const kontLabel = r.kontingen.sekolah_nama
      ? `${r.kontingen.kode} (${r.kontingen.sekolah_nama})`
      : r.kontingen.kode;

    state.root.innerHTML = `
      <div class="juri-shell">
        <div class="row-between no-print" style="margin-bottom:12px;">
          <button id="btn-receipt-home" class="btn btn-secondary btn-sm">← Kembali ke Pos</button>
          ${r.offline_pending ? '<span class="badge badge-orange">Menunggu Sync</span>' : '<span class="badge badge-green">Tersimpan</span>'}
        </div>

        <div class="thermal-paper" id="thermal-receipt-area">
          <div style="text-align:center; font-weight:700;">PMI KAB. PURBALINGGA</div>
          <div style="text-align:center;">${J.esc(r.kegiatan.nama)}</div>
          ${state.reprintBadge ? `<div style="text-align:center; font-weight:700; margin-top:4px;">*** ${J.esc(state.reprintBadge)} ***</div>` : ''}
          <hr />
          <div><strong>Pos:</strong> ${J.esc(r.pos.nama)}</div>
          <div><strong>Kontingen:</strong> ${J.esc(kontLabel)}</div>
          <hr />

          ${judges.length <= 1 && judges[0] ? `
            ${(judges[0].rubrik_nilai || []).map((item) => `
              <div class="thermal-row">
                <span>${J.esc(item.rubrik_nama)}</span>
                <span>${J.formatNum(item.nilai)}</span>
              </div>
            `).join('')}
            ${judges[0].komponen_subtotals && (judges[0].komponen_subtotals.Teori !== undefined || judges[0].komponen_subtotals.Praktik !== undefined) ? `
              <hr />
              ${judges[0].komponen_subtotals.Teori !== undefined ? `<div class="thermal-row"><span>Sub. Teori</span><span>${J.formatNum(judges[0].komponen_subtotals.Teori)}</span></div>` : ''}
              ${judges[0].komponen_subtotals.Praktik !== undefined ? `<div class="thermal-row"><span>Sub. Praktik</span><span>${J.formatNum(judges[0].komponen_subtotals.Praktik)}</span></div>` : ''}
            ` : ''}
          ` : judges.map((j, idx) => `
            <div style="font-weight:700; margin-top:4px;">Juri ${idx + 1}</div>
            ${(j.rubrik_nilai || []).map((item) => `
              <div class="thermal-row">
                <span>&nbsp;${J.esc(item.rubrik_nama)}</span>
                <span>${J.formatNum(item.nilai)}</span>
              </div>
            `).join('')}
            <div class="thermal-row" style="font-weight:700;">
              <span>&nbsp;Total Juri ${idx + 1}</span>
              <span>${J.formatNum(j.total_juri)}</span>
            </div>
          `).join('')}

          <hr />
          ${r.pos.pakai_timer ? `<div class="thermal-row"><span>Timer</span><span>${J.formatTimer(r.total_timer)}</span></div>` : ''}
          ${r.pos.pakai_bidak ? `<div class="thermal-row"><span>Bidak</span><span>${J.formatNum(r.bidak)}</span></div>` : ''}
          <div class="thermal-row" style="font-weight:700; font-size:14px; margin-top:4px;">
            <span>${judges.length > 1 ? `NILAI AKHIR (${r.pos.cara_gabung === 'jumlah' ? 'JML' : 'RATA2'})` : 'TOTAL'}</span>
            <span>${J.formatNum(r.nilai_akhir)}</span>
          </div>
          <hr />
          <div style="text-align:center; margin-top:8px;">
            <img src="${qrImg}" alt="QR Nilai" style="width:120px; height:120px;" />
            <div style="font-size:10px;">Pindai QR untuk lihat nilai &amp; PDF</div>
          </div>
        </div>

        <div class="grid no-print" style="gap:10px; margin-top:16px;">
          <button id="btn-print-ble" class="btn btn-primary btn-lg btn-block">Cetak ke Thermal Bluetooth (BLE)</button>
          <div class="row-gap">
            <button id="btn-print-browser" class="btn btn-secondary" style="flex:1;">Cetak Browser</button>
            <button id="btn-dl-pdf" class="btn btn-light-red" style="flex:1;">Unduh PDF A4</button>
          </div>
        </div>
      </div>
    `;

    state.root.querySelector('#btn-receipt-home').onclick = () => {
      state.view = 'home';
      render();
    };
    state.root.querySelector('#btn-print-ble').onclick = async () => {
      try {
        await BLE.printReceipt(r, state.reprintBadge);
        J.toast('Struk berhasil dikirim ke printer BLE.', 'success');
      } catch (err) {
        J.toast(err.message, 'error');
      }
    };
    state.root.querySelector('#btn-print-browser').onclick = () => window.print();
    state.root.querySelector('#btn-dl-pdf').onclick = () => J.downloadPosTranscriptPdf(r, { includeSchoolName: true });
  }

  function render() {
    if (state.view === 'session') renderSession();
    else if (state.view === 'receipt') renderReceipt();
    else renderHome();
  }

  return { mount };
})();
