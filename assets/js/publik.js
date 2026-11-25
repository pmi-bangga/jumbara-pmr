(() => {
  const J = window.JUMBARA;
  const app = document.getElementById('publik-app');
  const params = new URLSearchParams(window.location.search);

  const kontingenParam = params.get('kontingen');
  const posParam = params.get('pos');
  const kegiatanParam = params.get('kegiatan');

  if (kontingenParam && posParam) {
    renderPublicScorePage(kegiatanParam, kontingenParam, posParam);
  } else {
    renderTvBoard();
  }

  async function renderTvBoard() {
    let pollTimer = null;

    async function loadTv() {
      try {
        const data = await J.apiFetch('public_tv');
        const keg = data.kegiatan;
        const posList = data.pos_list || [];
        const rows = data.rows || [];
        const active = data.active_sessions || [];

        const bannerHtml = active.length > 0
          ? `<div class="tv-live-banner">
              <div class="row-gap">
                <span class="tv-pulse"></span>
                <div>
                  <div style="font-size:0.78rem; text-transform:uppercase; letter-spacing:0.08em; opacity:0.9;">Sedang Dinilai Saat Ini</div>
                  <div style="font-size:1.35rem; font-weight:800;">
                    ${active.map((a) => `${J.esc(a.kontingen_kode)} · ${J.esc(a.pos_nama)}`).join(' &nbsp;|&nbsp; ')}
                  </div>
                </div>
              </div>
              <span class="badge" style="background:rgba(255,255,255,0.2); color:#fff;">LIVE</span>
            </div>`
          : `<div class="tv-live-banner" style="background:#2d2d2d; box-shadow:none; border:1px solid #444;">
              <div style="font-size:1rem; font-weight:600; color:#eaeaea;">Menunggu sesi penilaian berikutnya di pos...</div>
              <span class="badge badge-gray">SIAGA</span>
            </div>`;

        const headCols = posList.map((p) => `<th style="text-align:center;">${J.esc(p.nama)}</th>`).join('');
        const bodyRows = rows.map((r) => {
          const isRowActive = posList.some((p) => r.cells[p.id] && r.cells[p.id].sedang_dinilai);
          const cols = posList.map((p) => {
            const cell = r.cells[p.id] || {};
            const activeCls = cell.sedang_dinilai ? 'tv-cell-active' : '';
            const valHtml = cell.nilai_akhir !== null && cell.nilai_akhir !== undefined
              ? `${J.formatNum(cell.nilai_akhir)}${cell.has_revisi ? ' <span class="badge badge-orange" style="font-size:0.65rem;">REVISI</span>' : ''}`
              : (cell.sedang_dinilai ? '<span style="color:#ffb3b3; font-size:0.9rem;">Dinilai...</span>' : '');
            return `<td class="${activeCls}" style="text-align:center;">${valHtml}</td>`;
          }).join('');
          return `<tr class="${isRowActive ? 'tv-row-active' : ''}">
            <td><span class="mono" style="font-size:1.2rem;">${J.esc(r.kode)}</span></td>
            ${cols}
          </tr>`;
        }).join('');

        app.innerHTML = `
          <div class="tv-screen">
            <div class="tv-header">
              <div class="brand">
                ${J.pmiLogoHtml(42, true)}
                <div>
                  <div class="brand-title" style="color:#fff; font-size:1.35rem;">${J.esc(keg ? keg.nama : 'Jumbara PMR PMI Kab. Purbalingga')}</div>
                  <div class="brand-sub" style="color:#bdbdbd;">Layar Pantau Nilai Pos · PMI Kabupaten Purbalingga</div>
                </div>
              </div>
              <div class="row-gap">
                <div style="text-align:right; font-size:0.85rem; opacity:0.85;">
                  <div>Pembaruan Otomatis</div>
                  <div class="mono" style="font-weight:700;">${J.esc((data.server_time || '').slice(11, 19))} WIB</div>
                </div>
                ${J.themeToggleButtonHtml()}
              </div>
            </div>

            ${bannerHtml}

            <div class="tv-table-wrap">
              <table class="tv-table">
                <thead>
                  <tr>
                    <th style="min-width:140px;">Kontingen</th>
                    ${headCols}
                  </tr>
                </thead>
                <tbody>
                  ${bodyRows || '<tr><td colspan="9" style="text-align:center; color:#aaa;">Belum ada kontingen terdaftar.</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        `;
      } catch (err) {
        if (!app.innerHTML) {
          app.innerHTML = `<div class="tv-screen"><div class="card">Gagal memuat layar TV: ${J.esc(err.message)}</div></div>`;
        }
      }
    }

    await loadTv();
    pollTimer = setInterval(loadTv, 3000);
    window.addEventListener('beforeunload', () => clearInterval(pollTimer));
  }

  async function renderPublicScorePage(kegId, kontKode, posId) {
    app.innerHTML = `
      <header class="topbar">
        <div class="brand">
          ${J.pmiLogoHtml(34)}
          <div style="border-left:1px solid var(--border-color); padding-left:12px;">
            <div class="brand-title">Hasil Nilai Resmi Pos</div>
            <div class="brand-sub">PMI Kabupaten Purbalingga</div>
          </div>
        </div>
        ${J.themeToggleButtonHtml()}
      </header>
      <main style="max-width:540px; margin:28px auto; padding:0 16px;">
        <div class="card">Memuat nilai resmi...</div>
      </main>
    `;

    try {
      const data = await J.apiFetch('public_nilai', {
        params: { kegiatan: kegId || '', kontingen: kontKode, pos: posId },
      });
      const sum = data.public_summary;
      const pdfData = data.pdf_transcript;
      const hasScore = (pdfData.juri_breakdown || []).length > 0;

      app.innerHTML = `
        <header class="topbar">
          <div class="brand">
            ${J.pmiLogoHtml(34)}
            <div style="border-left:1px solid var(--border-color); padding-left:12px;">
              <div class="brand-title">Hasil Nilai Resmi Pos</div>
              <div class="brand-sub">${J.esc(sum.kegiatan_nama)}</div>
            </div>
          </div>
          ${J.themeToggleButtonHtml()}
        </header>
        <main style="max-width:540px; margin:24px auto; padding:0 16px;">
          <div class="card" style="padding:24px;">
            <div class="row-between" style="margin-bottom:14px;">
              <span class="badge badge-red">KODE KONTINGEN</span>
              ${sum.has_revisi ? '<span class="badge badge-orange">REVISI</span>' : ''}
            </div>
            <div class="mono" style="font-size:2.2rem; font-weight:800; color:var(--pmi-dark); margin-bottom:6px;">
              ${J.esc(sum.kontingen_kode)}
            </div>
            <div style="font-size:1.05rem; font-weight:600; color:var(--pmi-gray); margin-bottom:20px;">
              Pos: <span style="color:var(--pmi-dark);">${J.esc(sum.pos_nama)}</span>
            </div>

            <div class="card card-red-tint" style="text-align:center; padding:22px; margin-bottom:20px;">
              <div style="font-size:0.82rem; font-weight:700; text-transform:uppercase; color:var(--pmi-red-dark); letter-spacing:0.06em;">
                Nilai Akhir Pos
              </div>
              <div style="font-size:3rem; font-weight:800; color:var(--pmi-red); line-height:1.15; margin-top:6px;">
                ${hasScore ? J.formatNum(sum.nilai_akhir) : '—'}
              </div>
              ${hasScore ? '' : '<div class="text-muted" style="font-size:0.86rem; margin-top:6px;">Nilai belum tersedia.</div>'}
            </div>

            <button id="btn-download-public-pdf" class="btn btn-primary btn-lg btn-block" ${hasScore ? '' : 'disabled'}>
              Unduh PDF Transkrip Nilai (A4)
            </button>
            <p class="text-muted" style="font-size:0.8rem; margin:12px 0 0; text-align:center;">
              Halaman publik hanya menampilkan kode kontingen, nama pos, dan nilai akhir tanpa data pribadi peserta.
            </p>
          </div>
        </main>
      `;

      const btn = document.getElementById('btn-download-public-pdf');
      if (btn && hasScore) {
        btn.addEventListener('click', () => {
          J.downloadPosTranscriptPdf(pdfData, { includeSchoolName: false });
        });
      }
    } catch (err) {
      app.innerHTML = `
        <header class="topbar">
          <div class="brand">
            ${J.pmiLogoHtml(34)}
            <div style="border-left:1px solid var(--border-color); padding-left:12px;">
              <div class="brand-title">Hasil Nilai Resmi Pos</div>
              <div class="brand-sub">PMI Kabupaten Purbalingga</div>
            </div>
          </div>
          ${J.themeToggleButtonHtml()}
        </header>
        <main style="max-width:540px; margin:24px auto; padding:0 16px;">
          <div class="card card-red-tint">
            <h3 style="margin-bottom:8px;">Data Tidak Ditemukan</h3>
            <p style="margin:0;">${J.esc(err.message)}</p>
          </div>
        </main>
      `;
    }
  }
})();
