(() => {
  const J = window.JUMBARA;
  const app = document.getElementById('app');

  let currentUser = null;
  let activeKegiatan = null;
  let sekolahList = [];
  let authTab = 'login'; // login | register

  async function init() {
    try {
      const me = await J.apiFetch('auth_me');
      currentUser = me.user;
      activeKegiatan = me.kegiatan;
      sekolahList = me.sekolah || [];
    } catch (err) {
      currentUser = null;
    }
    render();
  }

  function renderTopbar() {
    return `
      <header class="topbar no-print">
        <div class="brand">
          ${J.pmiLogoHtml(36)}
          <div style="min-width:0; border-left:1px solid var(--pmi-gray-lighter); padding-left:12px;">
            <div class="brand-title">SIJUM | Sistem Informasi Jumbara</div>
            <div class="brand-sub">${J.esc(activeKegiatan ? activeKegiatan.nama : 'PMI Kabupaten Purbalingga')}</div>
          </div>
        </div>
        <div class="row-gap">
          ${J.themeToggleButtonHtml()}
          ${currentUser ? `
            <div style="text-align:right; line-height:1.2;">
              <div class="fw-bold" style="font-size:0.86rem;">${J.esc(currentUser.nama)}</div>
              <div class="text-muted" style="font-size:0.74rem; text-transform:uppercase;">${J.esc(currentUser.peran)}</div>
            </div>
            <button id="btn-logout" class="btn btn-secondary btn-sm">Keluar</button>
          ` : `
            <a href="publik.html" class="btn btn-light-red btn-sm">Layar TV Publik ↗</a>
          `}
        </div>
      </header>
    `;
  }

  function renderAuthScreen() {
    app.innerHTML = `
      ${renderTopbar()}
      <main style="max-width:440px; margin:28px auto; padding:0 14px;">
        <div class="card" style="padding:22px;">
          <div class="row-gap" style="margin-bottom:18px; border-bottom:1px solid var(--pmi-gray-lighter); padding-bottom:10px;">
            <button id="tab-login" class="btn btn-sm ${authTab === 'login' ? 'btn-primary' : 'btn-secondary'}" style="flex:1;">Masuk</button>
            <button id="tab-reg" class="btn btn-sm ${authTab === 'register' ? 'btn-primary' : 'btn-secondary'}" style="flex:1;">Daftar Pembina</button>
          </div>

          ${authTab === 'login' ? `
            <form id="form-login">
              <div class="field">
                <label>Username</label>
                <input class="input" id="l-user" required autocomplete="username" placeholder="Masukkan username" />
              </div>
              <div class="field">
                <label>Password</label>
                <input class="input" id="l-pass" type="password" required autocomplete="current-password" placeholder="Masukkan password" />
              </div>
              <button type="submit" class="btn btn-primary btn-lg btn-block">Masuk Dashboard</button>
            </form>
            <div style="margin-top:16px; padding-top:14px; border-top:1px dashed var(--pmi-gray-lighter); font-size:0.82rem;">
              <div class="text-muted fw-bold" style="margin-bottom:8px;">Akun Demo Cepat:</div>
              <div class="row-gap">
                <button type="button" class="btn btn-secondary btn-sm quick-login" data-u="juri1" data-p="juri123">Juri 1 (Mobile)</button>
                <button type="button" class="btn btn-secondary btn-sm quick-login" data-u="pembina1" data-p="pembina123">Pembina 1</button>
                <button type="button" class="btn btn-secondary btn-sm quick-login" data-u="admin" data-p="admin123">Admin PMI</button>
              </div>
            </div>
          ` : `
            <form id="form-register">
              <div class="grid grid-2">
                <div class="field">
                  <label>1. Jenjang / Tingkat</label>
                  <select class="select" id="r-tingkat" required>
                    <option value="">-- Pilih Jenjang --</option>
                    ${((activeKegiatan && activeKegiatan.tingkat_aktif) || ['Mula', 'Madya', 'Wira']).map((t) => `<option value="${J.esc(t)}">${J.esc(t)}</option>`).join('')}
                  </select>
                </div>
                <div class="field">
                  <label>2. Kecamatan</label>
                  <select class="select" id="r-kecamatan" required>
                    <option value="">-- Pilih Jenjang dulu --</option>
                  </select>
                </div>
              </div>
              <div class="field">
                <label>3. Pilih Sekolah (dari daftar)</label>
                <select class="select" id="r-sekolah" required>
                  <option value="">-- Pilih Kecamatan dulu --</option>
                </select>
              </div>
              <div class="field">
                <label>4. Jenis Kontingen</label>
                <select class="select" id="r-jenis" required>
                  <option value="gabungan">Gabungan (Putra &amp; Putri)</option>
                  <option value="putra">Putra Saja</option>
                  <option value="putri">Putri Saja</option>
                </select>
              </div>
              <div class="field">
                <label>Nama Lengkap Pembina</label>
                <input class="input" id="r-nama" required placeholder="Nama pembina" />
              </div>
              <div class="field">
                <label>Username</label>
                <input class="input" id="r-user" required placeholder="Huruf/angka tanpa spasi" />
              </div>
              <div class="field">
                <label>Nomor WhatsApp (Wajib)</label>
                <input class="input" id="r-wa" required placeholder="0812..." />
              </div>
              <div class="field">
                <label>Password</label>
                <input class="input" id="r-pass" type="password" required minlength="6" placeholder="Minimal 6 karakter" />
              </div>
              <button type="submit" class="btn btn-primary btn-lg btn-block">Daftar Akun Pembina</button>
            </form>
          `}
        </div>
      </main>
    `;

    app.querySelector('#tab-login').onclick = () => { authTab = 'login'; render(); };
    app.querySelector('#tab-reg').onclick = () => { authTab = 'register'; render(); };

    const fLogin = app.querySelector('#form-login');
    if (fLogin) {
      fLogin.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const res = await J.apiFetch('auth_login', {
            method: 'POST',
            body: {
              username: app.querySelector('#l-user').value.trim(),
              password: app.querySelector('#l-pass').value,
            },
          });
          currentUser = res.user;
          const me = await J.apiFetch('auth_me');
          activeKegiatan = me.kegiatan;
          render();
        } catch (err) {
          J.toast(err.message, 'error');
        }
      };

      app.querySelectorAll('.quick-login').forEach((b) => {
        b.onclick = () => {
          app.querySelector('#l-user').value = b.dataset.u;
          app.querySelector('#l-pass').value = b.dataset.p;
          fLogin.dispatchEvent(new Event('submit', { cancelable: true }));
        };
      });
    }

    const fReg = app.querySelector('#form-register');
    if (fReg) {
      const selTingkat = app.querySelector('#r-tingkat');
      const selKec = app.querySelector('#r-kecamatan');
      const selSekolah = app.querySelector('#r-sekolah');

      selTingkat.onchange = () => {
        const jenjang = selTingkat.value;
        selSekolah.innerHTML = '<option value="">-- Pilih Kecamatan dulu --</option>';
        if (!jenjang) {
          selKec.innerHTML = '<option value="">-- Pilih Jenjang dulu --</option>';
          return;
        }
        const matching = sekolahList.filter((s) => !s.jenjang || s.jenjang.toLowerCase() === jenjang.toLowerCase());
        const kecSet = Array.from(new Set(matching.map((s) => s.kecamatan || 'Lainnya'))).sort((a, b) => a.localeCompare(b));
        selKec.innerHTML = '<option value="">-- Pilih Kecamatan --</option>' +
          kecSet.map((k) => `<option value="${J.esc(k)}">${J.esc(k)}</option>`).join('');
      };

      selKec.onchange = () => {
        const jenjang = selTingkat.value;
        const kec = selKec.value;
        if (!jenjang || !kec) {
          selSekolah.innerHTML = '<option value="">-- Pilih Kecamatan dulu --</option>';
          return;
        }
        const filtered = sekolahList.filter((s) => {
          const matchJenjang = !s.jenjang || s.jenjang.toLowerCase() === jenjang.toLowerCase();
          const sKec = s.kecamatan || 'Lainnya';
          return matchJenjang && sKec === kec;
        }).sort((a, b) => a.nama.localeCompare(b.nama));
        selSekolah.innerHTML = `<option value="">-- Pilih Sekolah (${filtered.length}) --</option>` +
          filtered.map((s) => `<option value="${s.id}">${J.esc(s.nama)}${s.npsn ? ' (' + J.esc(s.npsn) + ')' : ''}</option>`).join('');
      };

      fReg.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const res = await J.apiFetch('auth_register_pembina', {
            method: 'POST',
            body: {
              tingkat: selTingkat.value,
              sekolah_id: Number(selSekolah.value),
              jenis: app.querySelector('#r-jenis').value,
              nama: app.querySelector('#r-nama').value.trim(),
              username: app.querySelector('#r-user').value.trim(),
              no_wa: app.querySelector('#r-wa').value.trim(),
              password: app.querySelector('#r-pass').value,
            },
          });
          currentUser = res.user;
          J.toast('Pendaftaran akun pembina & kontingen berhasil!', 'success');
          render();
        } catch (err) {
          J.toast(err.message, 'error');
        }
      };
    }
  }

  function renderForceChangePassword() {
    app.innerHTML = `
      ${renderTopbar()}
      <main style="max-width:440px; margin:32px auto; padding:0 14px;">
        <div class="card card-red-tint" style="padding:22px;">
          <span class="badge badge-solid-red" style="margin-bottom:8px;">Wajib Ganti Password</span>
          <h3 style="margin-bottom:8px;">Buat Password Baru</h3>
          <p class="text-muted" style="margin:0 0 16px; font-size:0.9rem;">
            Anda masuk menggunakan password sementara. Silakan tetapkan password pribadi yang baru sebelum melanjutkan.
          </p>
          <form id="form-change-pw">
            <div class="field">
              <label>Password Baru (minimal 6 karakter)</label>
              <input class="input" id="npw-1" type="password" required minlength="6" />
            </div>
            <div class="field">
              <label>Ulangi Password Baru</label>
              <input class="input" id="npw-2" type="password" required minlength="6" />
            </div>
            <button type="submit" class="btn btn-primary btn-block">Simpan Password Baru</button>
          </form>
        </div>
      </main>
    `;
    bindLogout();
    app.querySelector('#form-change-pw').onsubmit = async (e) => {
      e.preventDefault();
      const p1 = app.querySelector('#npw-1').value;
      const p2 = app.querySelector('#npw-2').value;
      if (p1 !== p2) {
        J.toast('Konfirmasi password tidak cocok.', 'error');
        return;
      }
      try {
        await J.apiFetch('auth_change_password', { method: 'POST', body: { new_password: p1 } });
        currentUser.wajib_ganti_password = false;
        J.toast('Password berhasil diperbarui!', 'success');
        render();
      } catch (err) {
        J.toast(err.message, 'error');
      }
    };
  }

  function bindLogout() {
    const btn = document.getElementById('btn-logout');
    if (btn) {
      btn.onclick = async () => {
        await J.apiFetch('auth_logout', { method: 'POST', body: {} }).catch(() => {});
        currentUser = null;
        render();
      };
    }
  }

  function render() {
    if (!currentUser) {
      renderAuthScreen();
      return;
    }
    if (currentUser.wajib_ganti_password) {
      renderForceChangePassword();
      return;
    }

    app.innerHTML = `${renderTopbar()}<div id="role-workspace"></div>`;
    bindLogout();
    const ws = document.getElementById('role-workspace');

    if (currentUser.peran === 'juri') {
      window.JUMBARA_JURI.mount(ws, currentUser);
    } else if (currentUser.peran === 'pembina') {
      window.JUMBARA_PEMBINA.mount(ws, currentUser);
    } else if (currentUser.peran === 'admin') {
      window.JUMBARA_ADMIN.mount(ws, currentUser);
    }
  }

  init();
})();
