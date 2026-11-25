window.JUMBARA = (() => {
  const THEME_KEY = 'jumbara_theme';

  function getTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    const t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem(THEME_KEY, t);
    document.querySelectorAll('.btn-theme-toggle').forEach((btn) => {
      btn.innerHTML = themeButtonInner(t);
      btn.setAttribute('aria-label', t === 'dark' ? 'Aktifkan mode terang' : 'Aktifkan mode gelap');
    });
    return t;
  }

  function themeButtonInner(theme) {
    return theme === 'dark' ? '☀️ Terang' : '🌙 Gelap';
  }

  function themeToggleButtonHtml(extraClass = '') {
    const t = getTheme();
    return `<button type="button" class="btn btn-secondary btn-sm btn-theme-toggle ${extraClass}" title="Ganti tema Terang / Gelap">${themeButtonInner(t)}</button>`;
  }

  function toggleTheme() {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    return applyTheme(next);
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-theme-toggle');
    if (btn) toggleTheme();
  });

  applyTheme(getTheme());

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);
  }

  function formatTimer(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }

  function formatNum(num) {
    const n = Number(num);
    if (!Number.isFinite(n)) return '0';
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
  }

  function uuidv4() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function toast(message, type = 'info') {
    let box = document.getElementById('toast-container');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toast-container';
      box.className = 'toast-container no-print';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  async function apiFetch(action, { method = 'GET', body = null, params = {} } = {}) {
    const qs = new URLSearchParams({ action, ...params });
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`/api?${qs.toString()}`, opts);
    const data = await res.json().catch(() => ({ ok: false, error: 'Respons server tidak valid.' }));
    if (!res.ok || !data.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function makeQrMatrix(text) {
    const qr = window.qrcode(0, 'M');
    qr.addData(String(text));
    qr.make();
    return qr;
  }

  function makeQrDataUrl(text, cellSize = 4, margin = 2) {
    const qr = makeQrMatrix(text);
    return qr.createDataURL(cellSize, margin);
  }

  function pmiLogoHtml(height = 36, pill = false) {
    const img = `<img src="assets/img/logo-pmi.png" alt="Palang Merah Indonesia" class="brand-logo" style="height:${height}px;" />`;
    return pill ? `<div class="brand-logo-pill">${img}</div>` : img;
  }

  function pmiCrossSvg(size = 24) {
    return pmiLogoHtml(size);
  }

  /**
   * Section 23: Format PDF nilai pos
   * A4 transcript table matching receipt contents:
   * kegiatan, pos, kontingen, rubrik with values (and Teori/Praktik if applicable),
   * per-judge columns when >1 judge, timer/bidak if used, and final score.
   */
  function downloadPosTranscriptPdf(receipt, { includeSchoolName = false, filename = '' } = {}) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const kontLabel = includeSchoolName && receipt.kontingen.sekolah_nama
      ? `${receipt.kontingen.kode} — ${receipt.kontingen.sekolah_nama}`
      : receipt.kontingen.kode;

    doc.setFillColor(214, 1, 0);
    doc.rect(0, 0, 210, 18, 'F');
    doc.setTextColor(254, 254, 254);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text('PMI KABUPATEN PURBALINGGA · TRANSKRIP NILAI POS', 14, 11.5);

    doc.setTextColor(38, 38, 38);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text(receipt.kegiatan.nama || 'Jumbara PMR', 14, 27);

    doc.setFont('helvetica', 'normal');
    doc.text(`Pos Penilaian   : ${receipt.pos.nama}`, 14, 34);
    doc.text(`Kontingen       : ${kontLabel}`, 14, 40);
    doc.text(`Metode Gabung   : ${receipt.pos.cara_gabung === 'jumlah' ? 'Dijumlah' : 'Rata-rata'} (${receipt.pos.jumlah_juri} Juri)`, 14, 46);
    if (receipt.has_revisi) {
      doc.setTextColor(149, 16, 0);
      doc.setFont('helvetica', 'bold');
      doc.text('STATUS: REVISI DISETUJUI', 145, 34);
      doc.setTextColor(38, 38, 38);
    }

    const judges = receipt.juri_breakdown || [];
    const rubriks = receipt.rubriks || [];
    const head = ['No', 'Rubrik Penilaian', 'Komponen', 'Maks'];
    judges.forEach((j, idx) => {
      head.push(j.juri_nama ? `Juri ${idx + 1}\n(${j.juri_nama.slice(0, 14)})` : `Juri ${idx + 1}`);
    });
    if (judges.length === 0) head.push('Nilai');

    const body = rubriks.map((r, i) => {
      const row = [String(i + 1), r.nama, r.komponen || 'Umum', formatNum(r.nilai_maksimal)];
      if (judges.length === 0) {
        row.push('-');
      } else {
        judges.forEach((j) => {
          const found = (j.rubrik_nilai || []).find((x) => Number(x.rubrik_id) === Number(r.id));
          row.push(found ? formatNum(found.nilai) : '-');
        });
      }
      return row;
    });

    // Optional Teori / Praktik subtotals if present
    const hasKomp = rubriks.some((r) => r.komponen === 'Teori' || r.komponen === 'Praktik');
    if (hasKomp && judges.length > 0) {
      ['Teori', 'Praktik'].forEach((komp) => {
        if (rubriks.some((r) => r.komponen === komp)) {
          const subRow = ['', `Subtotal ${komp}`, komp, ''];
          judges.forEach((j) => {
            subRow.push(formatNum((j.komponen_subtotals && j.komponen_subtotals[komp]) || 0));
          });
          body.push(subRow);
        }
      });
    }

    if (judges.length > 0) {
      const totalRow = ['', 'Total per Juri', '', ''];
      judges.forEach((j) => totalRow.push(formatNum(j.total_juri)));
      body.push(totalRow);
    }

    doc.autoTable({
      startY: 53,
      head: [head],
      body,
      theme: 'grid',
      headStyles: { fillColor: [214, 1, 0], textColor: [255, 255, 255], fontStyle: 'bold' },
      styles: { fontSize: 9, cellPadding: 3 },
      columnStyles: { 0: { halign: 'center', cellWidth: 12 }, 3: { halign: 'right', cellWidth: 18 } },
    });

    let y = doc.lastAutoTable.finalY + 10;
    doc.setFillColor(250, 229, 229);
    doc.rect(14, y, 182, 24, 'F');
    doc.setDrawColor(214, 1, 0);
    doc.rect(14, y, 182, 24, 'S');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(149, 16, 0);
    doc.text(`NILAI AKHIR POS: ${formatNum(receipt.nilai_akhir)}`, 20, y + 10);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(40, 40, 40);
    const metaExtras = [];
    if (receipt.pos.pakai_timer) metaExtras.push(`Timer: ${formatTimer(receipt.total_timer)}`);
    if (receipt.pos.pakai_bidak) metaExtras.push(`Bidak: ${formatNum(receipt.bidak)}`);
    if (metaExtras.length > 0) {
      doc.text(metaExtras.join('   |   '), 20, y + 18);
    }

    const qrUrl = `${window.location.origin}${window.location.pathname.replace(/[^/]+$/, '')}publik.html?kegiatan=${receipt.kegiatan.id}&kontingen=${encodeURIComponent(receipt.kontingen.kode)}&pos=${receipt.pos.id}`;
    try {
      const qrImg = makeQrDataUrl(qrUrl, 4, 2);
      doc.addImage(qrImg, 'PNG', 168, y + 2, 20, 20);
    } catch (_) {}

    const fname = filename || `Transkrip-${receipt.kontingen.kode}-${receipt.pos.nama.replace(/[^a-z0-9]+/gi, '_')}.pdf`;
    doc.save(fname);
  }

  function downloadExcelWorkbook(sheets, filename) {
    if (!window.XLSX) {
      toast('Library Excel belum termuat.', 'error');
      return;
    }
    const wb = window.XLSX.utils.book_new();
    sheets.forEach(({ name, rows }) => {
      const ws = window.XLSX.utils.json_to_sheet(rows);
      window.XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
    });
    window.XLSX.writeFile(wb, filename);
  }

  return {
    getTheme,
    applyTheme,
    toggleTheme,
    themeToggleButtonHtml,
    esc,
    formatTimer,
    formatNum,
    uuidv4,
    toast,
    apiFetch,
    makeQrMatrix,
    makeQrDataUrl,
    pmiLogoHtml,
    pmiCrossSvg,
    downloadPosTranscriptPdf,
    downloadExcelWorkbook,
  };
})();
