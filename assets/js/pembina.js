window.JUMBARA_PEMBINA = (() => {
  const J = window.JUMBARA;
  let root = null;
  let data = null;
  let editingId = null;

  async function mount(el) {
    root = el;
    await reload();
  }

  async function reload() {
    try {
      data = await J.apiFetch('pembina_dashboard');
      render();
    } catch (err) {
      root.innerHTML = `<div style="max-width:760px; margin:24px auto; padding:0 16px;"><div class="card card-red-tint">${J.esc(err.message)}</div></div>`;
    }
  }

  function render() {
    const keg = data.kegiatan;
    const kont = data.kontingen;
    const peserta = data.peserta || [];

    if (!keg) {
      root.innerHTML = `<div style="max-width:760px; margin:24px auto; padding:0 16px;"><div class="card">Belum ada kegiatan Jumbara aktif.</div></div>`;
      return;
    }

    if (!kont) {
      const lockedByDate = keg.is_locked_by_date;
      root.innerHTML = `
        <div style="max-width:640px; margin:24px auto; padding:0 16px;">
          <div class="card">
            <span class="badge badge-red" style="margin-bottom:8px;">Pendaftaran Kontingen · ${J.esc(keg.tahun)}</span>
            <h2 style="margin-bottom:6px;">${J.esc(keg.nama)}</h2>
            <p class="text-muted" style="margin:0 0 16px; font-size:0.9rem;">
              Satu pembina mengelola satu kontingen. Hari kunci data: <strong>${J.esc(keg.hari_kunci)}</strong>.
            </p>
            ${lockedByDate ? `
              <div class="card card-red-tint">Pendaftaran sudah dikunci mulai tanggal ${J.esc(keg.hari_kunci)}.</div>
            ` : `
              <form id="form-create-kontingen">
                <div class="field">
                  <label>Pilih Sekolah (dari daftar Admin)</label>
                  <select class="select" id="k-sekolah" required>
                    <option value="">-- Pilih Sekolah --</option>
                    ${(data.sekolah || []).map((s) => `<option value="${s.id}">${J.esc(s.nama)}</option>`).join('')}
                  </select>
                </div>
                <div class="grid grid-2">
                  <div class="field">
                    <label>Tingkat PMR</label>
                    <select class="select" id="k-tingkat" required>
                      ${(keg.tingkat_aktif || []).map((t) => `<option value="${J.esc(t)}">${J.esc(t)}</option>`).join('')}
                    </select>
                  </div>
                  <div class="field">
                    <label>Jenis Kontingen</label>
                    <select class="select" id="k-jenis" required>
                      <option value="gabungan">Gabungan (Putra &amp; Putri)</option>
                      <option value="putra">Putra Saja</option>
                      <option value="putri">Putri Saja</option>
                    </select>
                  </div>
                </div>
                <button type="submit" class="btn btn-primary btn-block">Daftarkan Kontingen</button>
              </form>
            `}
          </div>
        </div>
      `;

      const f = root.querySelector('#form-create-kontingen');
      if (f) {
        f.onsubmit = async (e) => {
          e.preventDefault();
          try {
            await J.apiFetch('pembina_create_kontingen', {
              method: 'POST',
              body: {
                sekolah_id: Number(root.querySelector('#k-sekolah').value),
                tingkat: root.querySelector('#k-tingkat').value,
                jenis: root.querySelector('#k-jenis').value,
              },
            });
            J.toast('Kontingen berhasil didaftarkan!', 'success');
            await reload();
          } catch (err) {
            J.toast(err.message, 'error');
          }
        };
      }
      return;
    }

    const locked = !!kont.is_locked;
    const editTarget = editingId ? peserta.find((p) => Number(p.id) === Number(editingId)) : null;

    root.innerHTML = `
      <div style="max-width:960px; margin:20px auto; padding:0 16px;">
        <div class="card card-red-tint" style="margin-bottom:16px;">
          <div class="row-between">
            <div>
              <div class="row-gap" style="margin-bottom:4px;">
                <span class="badge badge-solid-red mono">${J.esc(kont.kode)}</span>
                <span class="badge ${locked ? 'badge-red' : 'badge-green'}">${locked ? 'Terkunci' : 'Terbuka s/d ' + J.esc(keg.hari_kunci)}</span>
              </div>
              <h2 style="font-size:1.25rem;">${J.esc(kont.sekolah_nama)}</h2>
              <div class="text-muted" style="font-size:0.88rem;">
                ${J.esc(keg.nama)} · Tingkat ${J.esc(kont.tingkat)} · Kontingen ${J.esc(kont.jenis)}
              </div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:0.78rem; color:var(--pmi-gray);">Jumlah Peserta</div>
              <div class="fw-bold" style="font-size:1.5rem; color:var(--pmi-red);">${peserta.length}</div>
            </div>
          </div>
        </div>

        <div class="grid grid-2" style="align-items:start;">
          <div class="card">
            <h3 style="margin-bottom:12px;">${editTarget ? 'Ubah Data Peserta' : 'Tambah Peserta Baru'}</h3>
            ${locked ? `
              <p class="text-muted" style="margin:0;">
                Data kontingen telah dikunci mulai hari kunci (${J.esc(keg.hari_kunci)}). Hubungi admin PMI apabila diperlukan perubahan data.
              </p>
            ` : `
              <form id="form-peserta">
                <div class="field">
                  <label>Nama Lengkap Peserta (Wajib)</label>
                  <input class="input" id="p-nama" required value="${editTarget ? J.esc(editTarget.nama) : ''}" placeholder="Contoh: Nadia Putri" />
                </div>
                <div class="field">
                  <label>Tanggal Lahir (Wajib)</label>
                  <input class="input" id="p-tgl" type="date" required value="${editTarget ? J.esc(editTarget.tanggal_lahir) : ''}" />
                </div>
                <div class="field">
                  <label>Nomor Kontak / WA (Opsional)</label>
                  <input class="input" id="p-kontak" value="${editTarget ? J.esc(editTarget.kontak) : ''}" placeholder="08..." />
                </div>
                <div class="row-gap">
                  <button type="submit" class="btn btn-primary" style="flex:1;">
                    ${editTarget ? 'Simpan Perubahan' : 'Tambah Peserta'}
                  </button>
                  ${editTarget ? `<button type="button" id="btn-cancel-edit" class="btn btn-secondary">Batal</button>` : ''}
                </div>
              </form>
            `}
          </div>

          <div class="card">
            <h3 style="margin-bottom:12px;">Daftar Peserta Kontingen ${J.esc(kont.kode)}</h3>
            ${peserta.length === 0 ? `
              <p class="text-muted" style="margin:0;">Belum ada peserta terdaftar.</p>
            ` : `
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Kode</th>
                      <th>Nama &amp; Tgl Lahir</th>
                      <th>Aksi</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${peserta.map((p) => `
                      <tr>
                        <td class="mono fw-bold">${J.esc(p.kode_peserta)}</td>
                        <td>
                          <div class="fw-bold">${J.esc(p.nama)}</div>
                          <div class="text-muted" style="font-size:0.8rem;">${J.esc(p.tanggal_lahir)}${p.kontak ? ' · ' + J.esc(p.kontak) : ''}</div>
                        </td>
                        <td>
                          <div class="row-gap">
                            <button class="btn btn-secondary btn-sm btn-qr-peserta" data-kode="${J.esc(p.kode_peserta)}" data-nama="${J.esc(p.nama)}">QR</button>
                            ${!locked ? `
                              <button class="btn btn-light-red btn-sm btn-edit-p" data-id="${p.id}">Ubah</button>
                              <button class="btn btn-ghost btn-sm btn-del-p" data-id="${p.id}" style="color:#b91c1c;">Hapus</button>
                            ` : ''}
                          </div>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            `}
          </div>
        </div>
      </div>
    `;

    const fp = root.querySelector('#form-peserta');
    if (fp) {
      fp.onsubmit = async (e) => {
        e.preventDefault();
        const body = {
          nama: root.querySelector('#p-nama').value.trim(),
          tanggal_lahir: root.querySelector('#p-tgl').value,
          kontak: root.querySelector('#p-kontak').value.trim(),
        };
        try {
          if (editTarget) {
            await J.apiFetch('pembina_update_peserta', { method: 'POST', body: { ...body, id: editTarget.id } });
            editingId = null;
            J.toast('Data peserta diperbarui.', 'success');
          } else {
            const res = await J.apiFetch('pembina_add_peserta', { method: 'POST', body });
            J.toast(`Peserta ditambahkan dengan kode ${res.kode_peserta}.`, 'success');
          }
          await reload();
        } catch (err) {
          J.toast(err.message, 'error');
        }
      };
    }

    const cancelEdit = root.querySelector('#btn-cancel-edit');
    if (cancelEdit) {
      cancelEdit.onclick = () => {
        editingId = null;
        render();
      };
    }

    root.querySelectorAll('.btn-edit-p').forEach((b) => {
      b.onclick = () => {
        editingId = Number(b.dataset.id);
        render();
      };
    });

    root.querySelectorAll('.btn-del-p').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Hapus peserta ini dari kontingen?')) return;
        try {
          await J.apiFetch('pembina_delete_peserta', { method: 'POST', body: { id: Number(b.dataset.id) } });
          J.toast('Peserta dihapus.', 'success');
          await reload();
        } catch (err) {
          J.toast(err.message, 'error');
        }
      };
    });

    root.querySelectorAll('.btn-qr-peserta').forEach((b) => {
      b.onclick = () => {
        const kode = b.dataset.kode;
        const nama = b.dataset.nama;
        const qrImg = J.makeQrDataUrl(kode, 5, 2);
        const modal = document.createElement('div');
        modal.className = 'modal-backdrop';
        modal.innerHTML = `
          <div class="modal-card" style="text-align:center;">
            <h3 style="margin-bottom:4px;">Kartu QR Peserta</h3>
            <div class="text-muted" style="margin-bottom:12px;">${J.esc(nama)}</div>
            <img src="${qrImg}" alt="QR ${J.esc(kode)}" style="width:180px; height:180px;" />
            <div class="mono fw-bold" style="font-size:1.4rem; margin:8px 0 14px;">${J.esc(kode)}</div>
            <button class="btn btn-primary btn-block" id="qr-ok">Tutup</button>
          </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('#qr-ok').onclick = () => modal.remove();
      };
    });
  }

  return { mount };
})();
