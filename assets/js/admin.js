window.JUMBARA_ADMIN = (() => {
  const J = window.JUMBARA;
  const BLE = window.BLE_PRINTER;

  let root = null;
  let tab = 'pos'; // pos | kegiatan | koreksi | akun | peserta | log | laporan | cetak
  let sidebarCollapsed = false;
  let selectedKegiatanId = null;
  let data = null;
  let logsData = { logs: [], activity_types: [] };
  let logFilters = { jenis: '', kontingen: '', pos: '', pelaku: '', q: '' };
  let editingPos = null;
  let lastResetResult = null;
  let printFilterKontingen = '';

  const NAV_ITEMS = [
    { id: 'pos', label: 'Pengaturan Pos' },
    { id: 'kegiatan', label: 'Kegiatan & Sekolah' },
    { id: 'koreksi', label: 'Koreksi Nilai' },
    { id: 'akun', label: 'Reset Akun & Juri' },
    { id: 'peserta', label: 'Kontingen & Peserta' },
    { id: 'log', label: 'Log Aktivitas' },
    { id: 'laporan', label: 'Laporan & Juara Umum' },
    { id: 'cetak', label: 'Cetak Kartu & Struk' },
  ];

  async function mount(el) {
    root = el;
    await reload();
  }

  async function reload() {
    try {
      const params = selectedKegiatanId ? { kegiatan_id: selectedKegiatanId } : {};
      data = await J.apiFetch('admin_bootstrap', { params });
      selectedKegiatanId = data.selected_kegiatan_id;
      if (tab === 'log') {
        await loadLogs();
      }
      render();
    } catch (err) {
      root.innerHTML = `<div class="admin-main"><div class="card card-red-tint">${J.esc(err.message)}</div></div>`;
    }
  }

  async function loadLogs() {
    logsData = await J.apiFetch('admin_logs', { params: logFilters });
  }

  function render() {
    const pendingKoreksiCount = (data.koreksi_list || []).filter((k) => k.status === 'diajukan').length;

    root.innerHTML = `
      <div class="admin-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}">
        <aside class="admin-sidebar no-print">
          <div style="padding:6px 10px 10px; border-bottom:1px solid var(--pmi-gray-lighter); margin-bottom:6px;">
            <div style="font-size:0.75rem; font-weight:700; color:var(--pmi-gray); text-transform:uppercase;">Kegiatan Dipilih</div>
            <select id="admin-keg-select" class="select" style="margin-top:6px; min-height:38px; font-size:0.86rem;">
              ${(data.kegiatan_list || []).map((kg) => `
                <option value="${kg.id}" ${Number(kg.id) === Number(selectedKegiatanId) ? 'selected' : ''}>
                  ${kg.tahun} · ${J.esc(kg.nama)}${kg.is_active ? ' (Aktif)' : ''}
                </option>
              `).join('')}
            </select>
          </div>
          ${NAV_ITEMS.map((item) => `
            <button class="nav-item ${tab === item.id ? 'active' : ''}" data-tab="${item.id}">
              <span>${J.esc(item.label)}</span>
              ${item.id === 'koreksi' && pendingKoreksiCount > 0 ? `<span class="badge badge-solid-red" style="margin-left:auto;">${pendingKoreksiCount}</span>` : ''}
            </button>
          `).join('')}
        </aside>

        <main class="admin-main">
          <div class="row-between no-print" style="margin-bottom:16px;">
            <div class="row-gap">
              <button id="btn-toggle-sidebar" class="btn btn-secondary btn-sm">
                ${sidebarCollapsed ? 'Tampilkan Menu Sidebar' : 'Sembunyikan Sidebar'}
              </button>
              <h2 style="font-size:1.3rem;">${J.esc((NAV_ITEMS.find((n) => n.id === tab) || {}).label || 'Admin')}</h2>
            </div>
            <a href="publik.html" target="_blank" class="btn btn-light-red btn-sm">Buka Layar TV Aula ↗</a>
          </div>

          <div id="admin-content"></div>
        </main>
      </div>
    `;

    root.querySelector('#btn-toggle-sidebar').onclick = () => {
      sidebarCollapsed = !sidebarCollapsed;
      render();
    };

    root.querySelector('#admin-keg-select').onchange = async (e) => {
      selectedKegiatanId = Number(e.target.value);
      editingPos = null;
      await reload();
    };

    root.querySelectorAll('.nav-item').forEach((btn) => {
      btn.onclick = async () => {
        tab = btn.dataset.tab;
        if (tab === 'log') await loadLogs();
        render();
      };
    });

    const content = root.querySelector('#admin-content');
    if (tab === 'pos') renderPosTab(content);
    else if (tab === 'kegiatan') renderKegiatanTab(content);
    else if (tab === 'koreksi') renderKoreksiTab(content);
    else if (tab === 'akun') renderAkunTab(content);
    else if (tab === 'peserta') renderPesertaTab(content);
    else if (tab === 'log') renderLogTab(content);
    else if (tab === 'laporan') renderLaporanTab(content);
    else if (tab === 'cetak') renderCetakTab(content);
  }

  function renderPosTab(container) {
    const posList = data.pos_list || [];
    const juriAccounts = (data.akun || []).filter((a) => a.peran === 'juri');

    const formModel = editingPos || {
      id: 0,
      nama: '',
      urutan_tiebreaker: posList.length + 1,
      jumlah_juri: 1,
      cara_gabung: 'rata_rata',
      pakai_timer: false,
      pakai_bidak: false,
      rubriks: [{ id: 0, nama: 'Penilaian Umum', komponen: 'Umum', nilai_maksimal: 100 }],
      juri_ids: [],
    };

    container.innerHTML = `
      <div class="grid grid-2" style="align-items:start;">
        <div class="card">
          <div class="row-between" style="margin-bottom:12px;">
            <h3>${formModel.id ? 'Ubah Pengaturan Pos' : 'Tambah Pos Baru'}</h3>
            ${formModel.id ? `<button id="btn-pos-new" class="btn btn-secondary btn-sm">+ Buat Pos Baru</button>` : ''}
          </div>
          <form id="form-pos">
            <div class="field">
              <label>Nama Pos</label>
              <input class="input" id="pos-nama" required value="${J.esc(formModel.nama)}" placeholder="Contoh: Pertolongan Pertama" />
            </div>
            <div class="grid grid-3">
              <div class="field">
                <label>Jumlah Juri</label>
                <select class="select" id="pos-juri-count">
                  ${[1, 2, 3].map((n) => `<option value="${n}" ${Number(formModel.jumlah_juri) === n ? 'selected' : ''}>${n} Juri</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <label>Gabung Nilai</label>
                <select class="select" id="pos-gabung">
                  <option value="rata_rata" ${formModel.cara_gabung === 'rata_rata' ? 'selected' : ''}>Rata-rata</option>
                  <option value="jumlah" ${formModel.cara_gabung === 'jumlah' ? 'selected' : ''}>Dijumlah</option>
                </select>
              </div>
              <div class="field">
                <label>Urutan Tiebreaker</label>
                <input class="input" id="pos-tie" type="number" min="1" value="${formModel.urutan_tiebreaker}" required />
              </div>
            </div>

            <div class="row-gap" style="margin-bottom:14px;">
              <label class="row-gap" style="cursor:pointer;">
                <input type="checkbox" id="pos-timer" ${formModel.pakai_timer ? 'checked' : ''} />
                <span>Pakai Timer</span>
              </label>
              <label class="row-gap" style="cursor:pointer; margin-left:14px;">
                <input type="checkbox" id="pos-bidak" ${formModel.pakai_bidak ? 'checked' : ''} />
                <span>Pakai Bidak</span>
              </label>
            </div>

            <div style="margin-bottom:14px;">
              <div class="row-between" style="margin-bottom:6px;">
                <strong style="font-size:0.88rem;">Rubrik Penilaian</strong>
                <button type="button" id="btn-add-rubrik" class="btn btn-light-red btn-sm">+ Rubrik</button>
              </div>
              <div id="rubrik-rows" class="grid" style="gap:8px;"></div>
            </div>

            <div style="margin-bottom:16px;">
              <strong style="font-size:0.88rem; display:block; margin-bottom:6px;">Penugasan Juri untuk Pos Ini</strong>
              <div class="grid" style="gap:6px; max-height:170px; overflow-y:auto; padding:8px; border:1px solid var(--pmi-gray-lighter); border-radius:8px;">
                ${juriAccounts.map((j) => `
                  <label class="row-gap" style="cursor:pointer; font-size:0.9rem;">
                    <input type="checkbox" class="chk-pos-juri" value="${j.id}" ${formModel.juri_ids.includes(Number(j.id)) ? 'checked' : ''} />
                    <span>${J.esc(j.nama)} <span class="text-muted mono">(@${J.esc(j.username)})</span></span>
                  </label>
                `).join('')}
              </div>
            </div>

            <button type="submit" class="btn btn-primary btn-block">Simpan Pos &amp; Penugasan Juri</button>
          </form>
        </div>

        <div class="card">
          <h3 style="margin-bottom:12px;">Daftar Pos &amp; Kesiapan Juri</h3>
          ${posList.length === 0 ? `<p class="text-muted">Belum ada pos untuk kegiatan ini.</p>` : `
            <div class="grid" style="gap:10px;">
              ${posList.map((p) => `
                <div style="border:1px solid var(--pmi-gray-lighter); border-radius:10px; padding:12px;">
                  <div class="row-between" style="margin-bottom:6px;">
                    <strong>${J.esc(p.nama)}</strong>
                    <span class="badge ${p.juri_lengkap ? 'badge-green' : 'badge-orange'}">
                      Juri ${p.juri_ditugaskan.length}/${p.jumlah_juri} ${p.juri_lengkap ? 'Lengkap' : 'Belum Lengkap'}
                    </span>
                  </div>
                  <div class="text-muted" style="font-size:0.82rem; margin-bottom:8px;">
                    Tiebreaker #${p.urutan_tiebreaker} · ${p.cara_gabung === 'jumlah' ? 'Dijumlah' : 'Rata-rata'}
                    ${p.pakai_timer ? ' · Timer' : ''}${p.pakai_bidak ? ' · Bidak' : ''} · ${p.rubriks.length} Rubrik
                  </div>
                  <div class="text-muted" style="font-size:0.82rem; margin-bottom:10px;">
                    Ditugaskan: ${p.juri_ditugaskan.length ? p.juri_ditugaskan.map((j) => J.esc(j.nama)).join(', ') : '<em>Belum ada</em>'}
                  </div>
                  <button class="btn btn-secondary btn-sm btn-edit-pos" data-id="${p.id}">Ubah Pos / Tugaskan Juri</button>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      </div>
    `;

    const rubRowsEl = container.querySelector('#rubrik-rows');
    const rubList = formModel.rubriks.map((r) => ({ ...r }));

    const drawRubriks = () => {
      rubRowsEl.innerHTML = rubList.map((r, idx) => `
        <div class="row-gap" style="background:var(--pmi-gray-light); padding:8px; border-radius:8px;">
          <input class="input r-nama" data-idx="${idx}" value="${J.esc(r.nama)}" placeholder="Nama rubrik" style="flex:2; min-width:140px; min-height:38px;" required />
          <select class="select r-komp" data-idx="${idx}" style="width:105px; min-height:38px;">
            ${['Umum', 'Teori', 'Praktik'].map((k) => `<option value="${k}" ${r.komponen === k ? 'selected' : ''}>${k}</option>`).join('')}
          </select>
          <input type="number" step="0.5" min="1" class="input r-maks" data-idx="${idx}" value="${r.nilai_maksimal}" style="width:76px; min-height:38px;" title="Nilai Maksimal" required />
          ${rubList.length > 1 ? `<button type="button" class="btn btn-ghost btn-sm r-del" data-idx="${idx}" style="color:#b91c1c; min-height:34px;">✕</button>` : ''}
        </div>
      `).join('');

      rubRowsEl.querySelectorAll('.r-nama').forEach((inp) => inp.oninput = () => { rubList[inp.dataset.idx].nama = inp.value; });
      rubRowsEl.querySelectorAll('.r-komp').forEach((sel) => sel.onchange = () => { rubList[sel.dataset.idx].komponen = sel.value; });
      rubRowsEl.querySelectorAll('.r-maks').forEach((inp) => inp.oninput = () => { rubList[inp.dataset.idx].nilai_maksimal = Number(inp.value); });
      rubRowsEl.querySelectorAll('.r-del').forEach((btn) => btn.onclick = () => { rubList.splice(Number(btn.dataset.idx), 1); drawRubriks(); });
    };
    drawRubriks();

    container.querySelector('#btn-add-rubrik').onclick = () => {
      rubList.push({ id: 0, nama: '', komponen: 'Umum', nilai_maksimal: 25 });
      drawRubriks();
    };

    const newBtn = container.querySelector('#btn-pos-new');
    if (newBtn) {
      newBtn.onclick = () => { editingPos = null; render(); };
    }

    container.querySelectorAll('.btn-edit-pos').forEach((b) => {
      b.onclick = () => {
        const p = posList.find((x) => Number(x.id) === Number(b.dataset.id));
        if (!p) return;
        editingPos = {
          ...p,
          juri_ids: (p.juri_ditugaskan || []).map((j) => Number(j.id)),
        };
        render();
      };
    });

    container.querySelector('#form-pos').onsubmit = async (e) => {
      e.preventDefault();
      const juriIds = Array.from(container.querySelectorAll('.chk-pos-juri:checked')).map((c) => Number(c.value));
      try {
        await J.apiFetch('admin_save_pos', {
          method: 'POST',
          body: {
            id: formModel.id,
            kegiatan_id: selectedKegiatanId,
            nama: container.querySelector('#pos-nama').value.trim(),
            jumlah_juri: Number(container.querySelector('#pos-juri-count').value),
            cara_gabung: container.querySelector('#pos-gabung').value,
            urutan_tiebreaker: Number(container.querySelector('#pos-tie').value),
            pakai_timer: container.querySelector('#pos-timer').checked,
            pakai_bidak: container.querySelector('#pos-bidak').checked,
            rubriks: rubList,
            juri_ids: juriIds,
          },
        });
        editingPos = null;
        J.toast('Pengaturan pos disimpan.', 'success');
        await reload();
      } catch (err) {
        J.toast(err.message, 'error');
      }
    };
  }

  function renderKegiatanTab(container) {
    const active = (data.kegiatan_list || []).find((k) => Number(k.id) === Number(selectedKegiatanId)) || null;
    container.innerHTML = `
      <div class="grid grid-2" style="align-items:start;">
        <div class="card">
          <h3 style="margin-bottom:12px;">Pengaturan Kegiatan Tahunan</h3>
          <form id="form-kegiatan">
            <input type="hidden" id="kg-id" value="${active ? active.id : 0}" />
            <div class="grid grid-2">
              <div class="field">
                <label>Tahun</label>
                <input class="input" id="kg-tahun" type="number" value="${active ? active.tahun : new Date().getFullYear()}" required />
              </div>
              <div class="field">
                <label>Tanggal Pelaksanaan</label>
                <input class="input" id="kg-tanggal" type="date" value="${active ? J.esc(active.tanggal) : ''}" required />
              </div>
            </div>
            <div class="field">
              <label>Nama Kegiatan</label>
              <input class="input" id="kg-nama" value="${active ? J.esc(active.nama) : ''}" required />
            </div>
            <div class="field">
              <label>Hari Kunci Pendaftaran (Pembina tidak bisa ubah mulai tanggal ini)</label>
              <input class="input" id="kg-kunci" type="date" value="${active ? J.esc(active.hari_kunci) : ''}" required />
            </div>
            <div class="field">
              <label>Tingkat Aktif</label>
              <div class="row-gap">
                ${['Mula', 'Madya', 'Wira'].map((t) => `
                  <label class="row-gap" style="cursor:pointer;">
                    <input type="checkbox" class="kg-tingkat" value="${t}" ${active && active.tingkat_aktif.includes(t) ? 'checked' : ''} />
                    <span>${t}</span>
                  </label>
                `).join('')}
              </div>
            </div>
            <label class="row-gap" style="margin-bottom:14px; cursor:pointer;">
              <input type="checkbox" id="kg-active" ${!active || active.is_active ? 'checked' : ''} />
              <span>Jadikan Kegiatan Aktif Utama</span>
            </label>
            <div class="row-gap">
              <button type="submit" class="btn btn-primary" style="flex:1;">Simpan Perubahan</button>
              <button type="button" id="btn-new-keg" class="btn btn-secondary">+ Buat Tahun Baru</button>
            </div>
          </form>
        </div>

        <div class="card">
          <h3 style="margin-bottom:10px;">Daftar Sekolah (Impor CSV)</h3>
          <p class="text-muted" style="font-size:0.84rem; margin:0 0 10px;">
            Unggah file CSV format <code>npsn;nama;jenjang;kecamatan;alamat</code> (pemisah <code>;</code> atau <code>,</code>) atau tempel daftar sekolah di bawah.
          </p>
          <input type="file" id="csv-file" accept=".csv,.txt" class="input" style="padding:8px; margin-bottom:10px;" />
          <textarea id="csv-text" class="textarea" placeholder="npsn;nama;jenjang;kecamatan;alamat&#10;20303588;SD NEGERI 1 PURBALINGGA LOR;Mula;KEC. PURBALINGGA;PURBALINGGA LOR"></textarea>
          <button id="btn-import-csv" class="btn btn-primary btn-block" style="margin-top:10px;">Impor Sekolah</button>

          <div style="margin-top:14px; max-height:240px; overflow-y:auto; border-top:1px solid var(--pmi-gray-lighter); padding-top:10px;">
            <strong style="font-size:0.85rem;">Sekolah Terdaftar (${(data.sekolah || []).length})</strong>
            <ul style="margin:6px 0 0; padding-left:18px; font-size:0.84rem;">
              ${(data.sekolah || []).map((s) => `<li><strong>${J.esc(s.nama)}</strong>${s.jenjang || s.kecamatan ? ` <span class="text-muted">(${[s.jenjang, s.kecamatan].filter(Boolean).map(J.esc).join(' · ')})</span>` : ''}</li>`).join('')}
            </ul>
          </div>
        </div>
      </div>
    `;

    container.querySelector('#btn-new-keg').onclick = () => {
      container.querySelector('#kg-id').value = 0;
      container.querySelector('#kg-tahun').value = new Date().getFullYear() + 1;
      container.querySelector('#kg-nama').value = '';
    };

    container.querySelector('#form-kegiatan').onsubmit = async (e) => {
      e.preventDefault();
      const tingkatAktif = Array.from(container.querySelectorAll('.kg-tingkat:checked')).map((c) => c.value);
      try {
        const res = await J.apiFetch('admin_save_kegiatan', {
          method: 'POST',
          body: {
            id: Number(container.querySelector('#kg-id').value),
            tahun: Number(container.querySelector('#kg-tahun').value),
            nama: container.querySelector('#kg-nama').value.trim(),
            tanggal: container.querySelector('#kg-tanggal').value,
            hari_kunci: container.querySelector('#kg-kunci').value,
            tingkat_aktif: tingkatAktif,
            is_active: container.querySelector('#kg-active').checked,
          },
        });
        selectedKegiatanId = res.id;
        J.toast('Kegiatan disimpan.', 'success');
        await reload();
      } catch (err) {
        J.toast(err.message, 'error');
      }
    };

    container.querySelector('#csv-file').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      container.querySelector('#csv-text').value = await file.text();
    };

    container.querySelector('#btn-import-csv').onclick = async () => {
      try {
        const res = await J.apiFetch('admin_import_sekolah', {
          method: 'POST',
          body: { csv_text: container.querySelector('#csv-text').value },
        });
        J.toast(`${res.added} sekolah baru ditambahkan.`, 'success');
        await reload();
      } catch (err) {
        J.toast(err.message, 'error');
      }
    };
  }

  function renderKoreksiTab(container) {
    const list = data.koreksi_list || [];
    container.innerHTML = `
      <div class="card">
        <h3 style="margin-bottom:12px;">Pengajuan Koreksi Nilai dari Juri</h3>
        ${list.length === 0 ? `<p class="text-muted">Belum ada pengajuan koreksi.</p>` : `
          <div class="grid" style="gap:12px;">
            ${list.map((k) => {
              const lama = JSON.parse(k.detail_lama || '{}');
              const baru = JSON.parse(k.detail_baru || '{}');
              return `
                <div style="border:1px solid var(--pmi-gray-lighter); border-radius:10px; padding:14px;">
                  <div class="row-between" style="margin-bottom:8px;">
                    <div>
                      <span class="mono fw-bold">${J.esc(k.kontingen_kode)}</span> · ${J.esc(k.sekolah_nama)}
                      <div class="text-muted" style="font-size:0.85rem;">Pos: ${J.esc(k.pos_nama)} · Pengaju: ${J.esc(k.juri_nama)} · ${J.esc(k.waktu_pengajuan)}</div>
                    </div>
                    <span class="badge ${k.status === 'disetujui' ? 'badge-green' : k.status === 'ditolak' ? 'badge-red' : 'badge-orange'}">${J.esc(k.status.toUpperCase())}</span>
                  </div>
                  <div style="background:var(--pmi-gray-light); padding:10px; border-radius:8px; margin-bottom:10px; font-size:0.88rem;">
                    <div><strong>Total Nilai:</strong> ${J.formatNum(k.nilai_lama)} → <strong class="text-red">${J.formatNum(k.nilai_baru)}</strong></div>
                    <div><strong>Alasan Juri:</strong> ${J.esc(k.alasan)}</div>
                    <div class="text-muted" style="font-size:0.82rem; margin-top:4px;">
                      Rincian Baru: ${(baru.scores || []).map((s) => `${J.esc(s.nama)}: ${J.formatNum(s.nilai)}`).join(' · ')}
                      ${baru.timer_detik ? ` · Timer: ${J.formatTimer(baru.timer_detik)}` : ''}
                      ${baru.bidak ? ` · Bidak: ${J.formatNum(baru.bidak)}` : ''}
                    </div>
                  </div>
                  ${k.status === 'diajukan' ? `
                    <div class="row-gap">
                      <button class="btn btn-success btn-sm btn-kr-acc" data-id="${k.id}">Setujui Koreksi</button>
                      <button class="btn btn-danger btn-sm btn-kr-rej" data-id="${k.id}">Tolak</button>
                    </div>
                  ` : `
                    <div class="text-muted" style="font-size:0.8rem;">Diproses oleh: ${J.esc(k.admin_nama || '-')} (${J.esc(k.waktu_keputusan || '')})</div>
                  `}
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>
    `;

    const decide = async (id, decision) => {
      try {
        await J.apiFetch('admin_decide_correction', {
          method: 'POST',
          body: { koreksi_id: id, decision },
        });
        J.toast(`Koreksi ${decision}.`, 'success');
        await reload();
      } catch (err) {
        J.toast(err.message, 'error');
      }
    };

    container.querySelectorAll('.btn-kr-acc').forEach((b) => b.onclick = () => decide(Number(b.dataset.id), 'disetujui'));
    container.querySelectorAll('.btn-kr-rej').forEach((b) => b.onclick = () => decide(Number(b.dataset.id), 'ditolak'));
  }

  function renderAkunTab(container) {
    const accounts = data.akun || [];
    container.innerHTML = `
      ${lastResetResult ? `
        <div class="card card-red-tint" style="margin-bottom:14px;">
          <div class="row-between">
            <div>
              <span class="badge badge-solid-red">Password Sementara Dibuat</span>
              <h3 style="margin-top:6px;">${J.esc(lastResetResult.nama)} (@${J.esc(lastResetResult.username)})</h3>
              <div>Password Sementara: <strong class="mono" style="font-size:1.2rem;">${J.esc(lastResetResult.temp_password)}</strong></div>
              <div class="text-muted" style="font-size:0.82rem;">Wajib diganti saat login pertama.</div>
            </div>
            <a href="${J.esc(lastResetResult.wa_url)}" target="_blank" class="btn btn-success">Kirim via WhatsApp ↗</a>
          </div>
        </div>
      ` : ''}

      <div class="grid grid-2" style="align-items:start;">
        <div class="card">
          <h3 style="margin-bottom:12px;">Buat Akun Juri Baru</h3>
          <form id="form-new-juri">
            <div class="field">
              <label>Nama Lengkap Juri</label>
              <input class="input" id="j-nama" required placeholder="dr. Budi..." />
            </div>
            <div class="field">
              <label>Username</label>
              <input class="input" id="j-user" required placeholder="juri4" />
            </div>
            <div class="field">
              <label>Nomor WhatsApp (Wajib)</label>
              <input class="input" id="j-wa" required placeholder="0812..." />
            </div>
            <div class="field">
              <label>Password Awal</label>
              <input class="input" id="j-pass" type="text" required minlength="6" placeholder="Minimal 6 karakter" />
            </div>
            <button type="submit" class="btn btn-primary btn-block">Buat Akun Juri</button>
          </form>
        </div>

        <div class="card">
          <h3 style="margin-bottom:12px;">Daftar Akun &amp; Reset Password</h3>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nama &amp; User</th>
                  <th>Peran</th>
                  <th>WhatsApp</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                ${accounts.map((a) => `
                  <tr>
                    <td>
                      <div class="fw-bold">${J.esc(a.nama)}</div>
                      <div class="mono text-muted" style="font-size:0.8rem;">@${J.esc(a.username)} ${Number(a.wajib_ganti_password) ? '<span class="badge badge-orange">Wajib Ganti PW</span>' : ''}</div>
                    </td>
                    <td><span class="badge ${a.peran === 'admin' ? 'badge-red' : a.peran === 'juri' ? 'badge-purple' : 'badge-gray'}">${J.esc(a.peran)}</span></td>
                    <td class="mono" style="font-size:0.84rem;">${J.esc(a.no_wa)}</td>
                    <td>
                      ${a.peran !== 'admin' ? `<button class="btn btn-light-red btn-sm btn-reset-acc" data-id="${a.id}">Reset PW</button>` : '-'}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    container.querySelector('#form-new-juri').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await J.apiFetch('admin_create_juri', {
          method: 'POST',
          body: {
            nama: container.querySelector('#j-nama').value.trim(),
            username: container.querySelector('#j-user').value.trim(),
            no_wa: container.querySelector('#j-wa').value.trim(),
            password: container.querySelector('#j-pass').value,
          },
        });
        J.toast('Akun juri berhasil dibuat.', 'success');
        await reload();
      } catch (err) {
        J.toast(err.message, 'error');
      }
    };

    container.querySelectorAll('.btn-reset-acc').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Buat password sementara baru dan tandai wajib ganti saat login pertama?')) return;
        try {
          lastResetResult = await J.apiFetch('admin_reset_account', {
            method: 'POST',
            body: { akun_id: Number(btn.dataset.id) },
          });
          J.toast('Password sementara berhasil dibuat.', 'success');
          await reload();
        } catch (err) {
          J.toast(err.message, 'error');
        }
      };
    });
  }

  function renderPesertaTab(container) {
    const konts = data.kontingen_list || [];
    const peserta = data.peserta_list || [];
    container.innerHTML = `
      <div class="card" style="margin-bottom:14px;">
        <h3 style="margin-bottom:10px;">Kontingen Terdaftar</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Kode</th><th>Sekolah</th><th>Tingkat / Jenis</th><th>Pembina</th><th>Status</th><th>Aksi</th></tr>
            </thead>
            <tbody>
              ${konts.map((k) => `
                <tr>
                  <td class="mono fw-bold">${J.esc(k.kode)}</td>
                  <td>${J.esc(k.sekolah_nama)}</td>
                  <td>${J.esc(k.tingkat)} · ${J.esc(k.jenis)}</td>
                  <td>${J.esc(k.pembina_nama)} (${J.esc(k.pembina_wa)})</td>
                  <td><span class="badge ${k.status === 'terkunci' ? 'badge-red' : 'badge-green'}">${J.esc(k.status)}</span></td>
                  <td>
                    <button class="btn btn-secondary btn-sm btn-toggle-lock" data-id="${k.id}" data-next="${k.status === 'terkunci' ? 'terbuka' : 'terkunci'}">
                      ${k.status === 'terkunci' ? 'Buka Kunci' : 'Kunci'}
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-bottom:10px;">Semua Peserta (Admin Dapat Mengubah Pasca Hari Kunci dengan Alasan)</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Kode Peserta</th><th>Kontingen &amp; Sekolah</th><th>Nama</th><th>Tgl Lahir</th><th>Aksi</th></tr>
            </thead>
            <tbody>
              ${peserta.map((p) => `
                <tr>
                  <td class="mono fw-bold">${J.esc(p.kode_peserta)}</td>
                  <td><span class="mono">${J.esc(p.kontingen_kode)}</span> · ${J.esc(p.sekolah_nama)}</td>
                  <td>${J.esc(p.nama)}</td>
                  <td class="mono">${J.esc(p.tanggal_lahir)}</td>
                  <td><button class="btn btn-light-red btn-sm btn-adm-edit-p" data-id="${p.id}">Ubah Data</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelectorAll('.btn-toggle-lock').forEach((b) => {
      b.onclick = async () => {
        const alasan = prompt('Alasan perubahan status kunci kontingen:', 'Pengaturan admin');
        if (alasan === null) return;
        try {
          await J.apiFetch('admin_toggle_kontingen_lock', {
            method: 'POST',
            body: { kontingen_id: Number(b.dataset.id), status: b.dataset.next, alasan },
          });
          J.toast('Status kontingen diperbarui.', 'success');
          await reload();
        } catch (err) {
          J.toast(err.message, 'error');
        }
      };
    });

    container.querySelectorAll('.btn-adm-edit-p').forEach((b) => {
      b.onclick = () => {
        const p = peserta.find((x) => Number(x.id) === Number(b.dataset.id));
        if (!p) return;
        const modal = document.createElement('div');
        modal.className = 'modal-backdrop';
        modal.innerHTML = `
          <div class="modal-card">
            <h3 style="margin-bottom:10px;">Ubah Peserta ${J.esc(p.kode_peserta)} (Admin)</h3>
            <form id="adm-p-form">
              <div class="field"><label>Nama</label><input class="input" id="ap-nama" value="${J.esc(p.nama)}" required /></div>
              <div class="field"><label>Tanggal Lahir</label><input class="input" id="ap-tgl" type="date" value="${J.esc(p.tanggal_lahir)}" required /></div>
              <div class="field"><label>Kontak</label><input class="input" id="ap-kontak" value="${J.esc(p.kontak)}" /></div>
              <div class="field"><label>Alasan Perubahan (Wajib Tercatat di Log)</label><textarea class="textarea" id="ap-alasan" required placeholder="Alasan perubahan data..."></textarea></div>
              <div class="row-gap" style="justify-content:flex-end;">
                <button type="button" class="btn btn-secondary" id="ap-cancel">Batal</button>
                <button type="submit" class="btn btn-primary">Simpan</button>
              </div>
            </form>
          </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('#ap-cancel').onclick = () => modal.remove();
        modal.querySelector('#adm-p-form').onsubmit = async (e) => {
          e.preventDefault();
          try {
            await J.apiFetch('admin_update_peserta', {
              method: 'POST',
              body: {
                id: p.id,
                nama: modal.querySelector('#ap-nama').value.trim(),
                tanggal_lahir: modal.querySelector('#ap-tgl').value,
                kontak: modal.querySelector('#ap-kontak').value.trim(),
                alasan: modal.querySelector('#ap-alasan').value.trim(),
              },
            });
            modal.remove();
            J.toast('Data peserta diperbarui & tercatat di log.', 'success');
            await reload();
          } catch (err) {
            J.toast(err.message, 'error');
          }
        };
      };
    });
  }

  function renderLogTab(container) {
    const logs = logsData.logs || [];
    const types = logsData.activity_types || [];

    container.innerHTML = `
      <div class="card">
        <div class="row-between" style="margin-bottom:12px;">
          <div>
            <h3>Log Aktivitas (Hanya-Baca)</h3>
            <div class="text-muted" style="font-size:0.82rem;">Semua catatan aktivitas tersimpan permanen dan tidak dapat dihapus atau diubah.</div>
          </div>
        </div>

        <form id="log-filter-form" class="grid grid-3" style="margin-bottom:14px;">
          <select class="select" id="lf-jenis">
            <option value="">Semua Jenis Aktivitas</option>
            ${types.map((t) => `<option value="${J.esc(t)}" ${logFilters.jenis === t ? 'selected' : ''}>${J.esc(t)}</option>`).join('')}
          </select>
          <input class="input" id="lf-kontingen" placeholder="Filter Kontingen (MU001)" value="${J.esc(logFilters.kontingen)}" />
          <input class="input" id="lf-pos" placeholder="Filter Pos" value="${J.esc(logFilters.pos)}" />
          <input class="input" id="lf-pelaku" placeholder="Filter Pelaku / Juri" value="${J.esc(logFilters.pelaku)}" />
          <input class="input" id="lf-q" placeholder="Cari detail..." value="${J.esc(logFilters.q)}" />
          <button type="submit" class="btn btn-primary">Terapkan Filter</button>
        </form>

        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Waktu</th><th>Pelaku</th><th>Aktivitas</th><th>Kontingen / Pos</th><th>Detail</th></tr>
            </thead>
            <tbody>
              ${logs.map((l) => `
                <tr>
                  <td class="mono" style="font-size:0.8rem; white-space:nowrap;">${J.esc(l.waktu)}</td>
                  <td>
                    <div class="fw-bold">${J.esc(l.pelaku_nama)}</div>
                    <div class="text-muted" style="font-size:0.78rem;">${J.esc(l.pelaku_peran)}</div>
                  </td>
                  <td><span class="badge badge-gray">${J.esc(l.jenis_aktivitas)}</span></td>
                  <td style="font-size:0.84rem;">
                    ${l.kontingen_kode ? `<span class="mono fw-bold">${J.esc(l.kontingen_kode)}</span>` : '-'}
                    ${l.pos_nama ? `<div>${J.esc(l.pos_nama)}</div>` : ''}
                  </td>
                  <td style="font-size:0.86rem;">${J.esc(l.detail)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#log-filter-form').onsubmit = async (e) => {
      e.preventDefault();
      logFilters = {
        jenis: container.querySelector('#lf-jenis').value,
        kontingen: container.querySelector('#lf-kontingen').value.trim(),
        pos: container.querySelector('#lf-pos').value.trim(),
        pelaku: container.querySelector('#lf-pelaku').value.trim(),
        q: container.querySelector('#lf-q').value.trim(),
      };
      await loadLogs();
      render();
    };
  }

  function renderLaporanTab(container) {
    const rep = data.reports;
    if (!rep) {
      container.innerHTML = `<div class="card">Belum ada data laporan.</div>`;
      return;
    }

    const posList = rep.pos_list || [];
    const juara = rep.juara_umum || [];
    const aktif = rep.peserta_paling_aktif || [];

    container.innerHTML = `
      <div class="grid" style="gap:16px;">
        <!-- Juara Umum (Dinamis) -->
        <div class="card">
          <div class="row-between" style="margin-bottom:12px;">
            <div>
              <h3>Juara Umum (Dihitung Dinamis)</h3>
              <div class="text-muted" style="font-size:0.82rem;">
                Urutan tiebreaker: Total Nilai → Total Timer pos bertimer → Bidak → Urutan Tiebreaker Pos.
              </div>
            </div>
            <div class="row-gap">
              <button id="btn-pdf-juara" class="btn btn-primary btn-sm">Unduh PDF Arsip Juara Umum</button>
              <button id="btn-xls-all" class="btn btn-success btn-sm">Ekspor Excel (.xlsx)</button>
            </div>
          </div>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Peringkat</th>
                  <th>Kontingen &amp; Sekolah</th>
                  ${posList.map((p) => `<th>${J.esc(p.nama)}</th>`).join('')}
                  <th>Total Timer</th>
                  <th>Bidak</th>
                  <th>Total Nilai</th>
                </tr>
              </thead>
              <tbody>
                ${juara.map((r) => `
                  <tr>
                    <td><span class="badge ${r.peringkat === 1 ? 'badge-solid-red' : 'badge-gray'}">#${r.peringkat}</span></td>
                    <td>
                      <div class="mono fw-bold">${J.esc(r.kode)}</div>
                      <div style="font-size:0.84rem;">${J.esc(r.sekolah_nama)}</div>
                    </td>
                    ${posList.map((p) => {
                      const sc = r.pos_scores[p.id];
                      return `<td>${sc ? J.formatNum(sc.nilai_akhir) : '-'}</td>`;
                    }).join('')}
                    <td class="mono">${J.formatTimer(r.total_timer)}</td>
                    <td>${J.formatNum(r.total_bidak)}</td>
                    <td class="fw-bold text-red" style="font-size:1.05rem;">${J.formatNum(r.total_nilai)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Peserta Paling Aktif -->
        <div class="card">
          <h3 style="margin-bottom:8px;">Peserta Paling Aktif (Usia Termuda)</h3>
          <p class="text-muted" style="font-size:0.82rem; margin:0 0 10px;">Terpisah dari aturan Juara Umum — diurutkan berdasarkan tanggal lahir termuda dari peserta yang memiliki kehadiran pos.</p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>#</th><th>Kode</th><th>Nama</th><th>Tgl Lahir</th><th>Kontingen &amp; Sekolah</th><th>Pos Diikuti</th></tr>
              </thead>
              <tbody>
                ${aktif.length === 0 ? `<tr><td colspan="6" class="text-muted">Belum ada data kehadiran selesai.</td></tr>` : aktif.map((a, idx) => `
                  <tr>
                    <td>${idx + 1}</td>
                    <td class="mono fw-bold">${J.esc(a.kode_peserta)}</td>
                    <td class="fw-bold">${J.esc(a.nama)}</td>
                    <td class="mono">${J.esc(a.tanggal_lahir)}</td>
                    <td>${J.esc(a.kontingen_kode)} · ${J.esc(a.sekolah_nama)}</td>
                    <td>${a.jumlah_pos_diikuti}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Rincian Per Pos Per Kontingen -->
        <div class="card">
          <div class="row-between" style="margin-bottom:10px;">
            <h3>Laporan Rinci per Pos per Kontingen (A4 PDF &amp; Excel)</h3>
            <button id="btn-load-detailed" class="btn btn-light-red btn-sm">Muat Semua Rincian Juri &amp; Rubrik</button>
          </div>
          <div id="detailed-report-box" class="text-muted" style="font-size:0.88rem;">
            Klik tombol di atas untuk memuat rincian rubrik per juri dan unduh transkrip A4 PDF per pos atau Excel lengkap.
          </div>
        </div>
      </div>
    `;

    container.querySelector('#btn-pdf-juara').onclick = () => {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      doc.setFillColor(214, 1, 0);
      doc.rect(0, 0, 297, 16, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.text('PMI KAB. PURBALINGGA · ARSIP RESMI JUARA UMUM JUMBARA PMR', 14, 10.5);

      const head = ['Rank', 'Kode', 'Sekolah', ...posList.map((p) => p.nama), 'Timer', 'Bidak', 'Total'];
      const body = juara.map((r) => [
        String(r.peringkat),
        r.kode,
        r.sekolah_nama,
        ...posList.map((p) => (r.pos_scores[p.id] ? J.formatNum(r.pos_scores[p.id].nilai_akhir) : '-')),
        J.formatTimer(r.total_timer),
        J.formatNum(r.total_bidak),
        J.formatNum(r.total_nilai),
      ]);

      doc.autoTable({
        startY: 22,
        head: [head],
        body,
        theme: 'grid',
        headStyles: { fillColor: [214, 1, 0], textColor: [255, 255, 255] },
        styles: { fontSize: 8.5 },
      });
      doc.save(`Arsip-Juara-Umum-${Date.now()}.pdf`);
    };

    container.querySelector('#btn-xls-all').onclick = async () => {
      try {
        const det = await J.apiFetch('admin_detailed_report', { params: { kegiatan_id: selectedKegiatanId } });
        const juaraRows = juara.map((r) => {
          const row = { Peringkat: r.peringkat, Kode: r.kode, Sekolah: r.sekolah_nama, Tingkat: r.tingkat, Jenis: r.jenis };
          posList.forEach((p) => { row[p.nama] = r.pos_scores[p.id] ? r.pos_scores[p.id].nilai_akhir : ''; });
          row['Total Timer (dtk)'] = r.total_timer;
          row['Total Bidak'] = r.total_bidak;
          row['Total Nilai'] = r.total_nilai;
          return row;
        });

        const detailRows = [];
        (det.receipts || []).forEach((rc) => {
          (rc.juri_breakdown || []).forEach((jb) => {
            (jb.rubrik_nilai || []).forEach((rn) => {
              detailRows.push({
                Pos: rc.pos.nama,
                Kode_Kontingen: rc.kontingen.kode,
                Sekolah: rc.kontingen.sekolah_nama,
                Juri: jb.juri_nama,
                Komponen: rn.komponen,
                Rubrik: rn.rubrik_nama,
                Maksimal: rn.nilai_maksimal,
                Nilai: rn.nilai,
                Timer_Detik: jb.timer_detik,
                Bidak: jb.bidak,
                Nilai_Akhir_Pos: rc.nilai_akhir,
                Status_Revisi: rc.has_revisi ? 'REVISI' : 'ASLI',
              });
            });
          });
        });

        J.downloadExcelWorkbook([
          { name: 'Juara Umum & Matriks', rows: juaraRows },
          { name: 'Rincian Juri & Rubrik', rows: detailRows },
          { name: 'Peserta Paling Aktif', rows: aktif },
        ], `Laporan-Jumbara-${selectedKegiatanId}.xlsx`);
      } catch (err) {
        J.toast(err.message, 'error');
      }
    };

    container.querySelector('#btn-load-detailed').onclick = async () => {
      const box = container.querySelector('#detailed-report-box');
      box.textContent = 'Memuat rincian...';
      try {
        const det = await J.apiFetch('admin_detailed_report', { params: { kegiatan_id: selectedKegiatanId } });
        const receipts = det.receipts || [];
        if (receipts.length === 0) {
          box.textContent = 'Belum ada nilai pos yang masuk.';
          return;
        }
        box.innerHTML = `
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>Pos</th><th>Kontingen &amp; Sekolah</th><th>Juri &amp; Rincian Rubrik</th><th>Nilai Akhir</th><th>PDF</th></tr>
              </thead>
              <tbody>
                ${receipts.map((rc, idx) => `
                  <tr>
                    <td class="fw-bold">${J.esc(rc.pos.nama)}</td>
                    <td><span class="mono fw-bold">${J.esc(rc.kontingen.kode)}</span><div style="font-size:0.82rem;">${J.esc(rc.kontingen.sekolah_nama)}</div></td>
                    <td style="font-size:0.82rem;">
                      ${rc.juri_breakdown.map((jb) => `
                        <div style="margin-bottom:4px;">
                          <strong>${J.esc(jb.juri_nama)}</strong> (${J.formatNum(jb.total_juri)}):
                          ${jb.rubrik_nilai.map((rn) => `${J.esc(rn.rubrik_nama)}=${J.formatNum(rn.nilai)}`).join(', ')}
                        </div>
                      `).join('')}
                    </td>
                    <td class="fw-bold text-red">${J.formatNum(rc.nilai_akhir)} ${rc.has_revisi ? '<span class="badge badge-orange">REVISI</span>' : ''}</td>
                    <td><button class="btn btn-secondary btn-sm btn-det-pdf" data-idx="${idx}">Unduh PDF</button></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
        box.querySelectorAll('.btn-det-pdf').forEach((b) => {
          b.onclick = () => J.downloadPosTranscriptPdf(receipts[Number(b.dataset.idx)], { includeSchoolName: true });
        });
      } catch (err) {
        box.textContent = err.message;
      }
    };
  }

  function renderCetakTab(container) {
    const konts = data.kontingen_list || [];
    const allPeserta = data.peserta_list || [];
    const filtered = printFilterKontingen
      ? allPeserta.filter((p) => p.kontingen_kode === printFilterKontingen)
      : allPeserta;

    container.innerHTML = `
      <div class="card" style="margin-bottom:16px;">
        <div class="row-between no-print" style="margin-bottom:12px;">
          <div>
            <h3>Cetak Kartu QR Peserta (Label 50 × 30 mm)</h3>
            <div class="text-muted" style="font-size:0.82rem;">QR hanya berisi kode peserta. Dapat dicetak via Bluetooth BLE atau printer browser.</div>
          </div>
          <div class="row-gap">
            <select id="cetak-filter-k" class="select" style="width:200px; min-height:38px;">
              <option value="">Semua Kontingen (${allPeserta.length})</option>
              ${konts.map((k) => `<option value="${J.esc(k.kode)}" ${printFilterKontingen === k.kode ? 'selected' : ''}>${J.esc(k.kode)} · ${J.esc(k.sekolah_nama)}</option>`).join('')}
            </select>
            <button id="btn-ble-labels" class="btn btn-primary btn-sm">Cetak Label BLE (${filtered.length})</button>
            <button id="btn-print-labels" class="btn btn-secondary btn-sm">Cetak Browser</button>
          </div>
        </div>

        <div class="label-sheet">
          ${filtered.map((p) => {
            const qrUrl = J.makeQrDataUrl(p.kode_peserta, 3, 1);
            return `
              <div class="label-50x30">
                <img src="${qrUrl}" alt="QR ${J.esc(p.kode_peserta)}" style="width:23mm; height:23mm;" />
                <div style="flex:1; min-width:0; text-align:right;">
                  <div style="font-size:7pt; color:#D60100; font-weight:700;">JUMBARA PMR</div>
                  <div class="mono" style="font-size:11pt; font-weight:800;">${J.esc(p.kode_peserta)}</div>
                  <div style="font-size:7pt; color:#555; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${J.esc(p.nama)}</div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;

    container.querySelector('#cetak-filter-k').onchange = (e) => {
      printFilterKontingen = e.target.value;
      render();
    };
    container.querySelector('#btn-print-labels').onclick = () => window.print();
    container.querySelector('#btn-ble-labels').onclick = async () => {
      if (filtered.length === 0) return;
      try {
        await BLE.printLabels50x30(filtered);
        J.toast(`${filtered.length} label QR dikirim ke printer BLE.`, 'success');
      } catch (err) {
        J.toast(err.message, 'error');
      }
    };
  }

  return { mount };
})();
