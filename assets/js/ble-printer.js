window.BLE_PRINTER = (() => {
  const SERVICE_CANDIDATES = [
    '000018f0-0000-1000-8000-00805f9b34fb',
    '0000ff00-0000-1000-8000-00805f9b34fb',
    '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  ];

  let activeChar = null;
  let activeDevice = null;

  function isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  function getStatus() {
    if (!isSupported()) return { supported: false, connected: false, name: '' };
    return {
      supported: true,
      connected: !!(activeDevice && activeDevice.gatt && activeDevice.gatt.connected && activeChar),
      name: activeDevice ? (activeDevice.name || 'Printer BLE') : '',
    };
  }

  async function connect() {
    if (!isSupported()) {
      throw new Error('Web Bluetooth hanya didukung di Chrome Android atau Chrome Desktop (HTTPS/localhost).');
    }

    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: SERVICE_CANDIDATES,
    });

    const server = await device.gatt.connect();
    const services = await server.getPrimaryServices();

    let writable = null;
    for (const svc of services) {
      const chars = await svc.getCharacteristics();
      for (const ch of chars) {
        if (ch.properties.write || ch.properties.writeWithoutResponse) {
          writable = ch;
          break;
        }
      }
      if (writable) break;
    }

    if (!writable) {
      throw new Error('Karakteristik tulis BLE tidak ditemukan pada printer ini (pastikan printer mendukung BLE, bukan Bluetooth Classic SPP saja).');
    }

    activeDevice = device;
    activeChar = writable;
    device.addEventListener('gattserverdisconnected', () => {
      activeChar = null;
    });
    return getStatus();
  }

  async function writeBytes(bytes) {
    if (!activeChar) {
      await connect();
    }
    const chunkSize = 100;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const slice = bytes.slice(i, i + chunkSize);
      if (activeChar.properties.writeWithoutResponse) {
        await activeChar.writeValueWithoutResponse(slice);
      } else {
        await activeChar.writeValue(slice);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  function asciiBytes(str) {
    const clean = String(str)
      .replace(/[^\x20-\x7E\n]/g, ' ')
      .replace(/\r/g, '');
    const out = [];
    for (let i = 0; i < clean.length; i++) {
      out.push(clean.charCodeAt(i));
    }
    return out;
  }

  function padLine(left, right, width = 32) {
    const l = String(left).slice(0, width - 2);
    const r = String(right);
    const spaces = Math.max(1, width - l.length - r.length);
    return l + ' '.repeat(spaces) + r + '\n';
  }

  function buildEscPosQr(data) {
    const bytes = asciiBytes(data);
    const storeLen = bytes.length + 3;
    const pL = storeLen % 256;
    const pH = Math.floor(storeLen / 256);
    return [
      0x1B, 0x61, 0x01, // Center
      0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00, // QR Model 2
      0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, 0x05,       // Module size 5
      0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x31,       // ECC M
      0x1D, 0x28, 0x6B, pL, pH, 0x31, 0x50, 0x30,           // Store data
      ...bytes,
      0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30,       // Print QR
      0x1B, 0x61, 0x00, // Left
    ];
  }

  /**
   * Section 7: Minimalist Thermal Receipt (NO participant names!)
   */
  function buildReceiptBytes(receipt, reprintBadge = '') {
    const J = window.JUMBARA;
    const buf = [0x1B, 0x40]; // ESC @ init
    const line = '--------------------------------\n';

    buf.push(0x1B, 0x61, 0x01, 0x1B, 0x45, 0x01); // Center + Bold
    buf.push(...asciiBytes('PMI KAB. PURBALINGGA\n'));
    buf.push(...asciiBytes((receipt.kegiatan.nama || 'JUMBARA PMR') + '\n'));
    if (reprintBadge) {
      buf.push(...asciiBytes(`*** ${reprintBadge} ***\n`));
    }
    buf.push(0x1B, 0x45, 0x00, 0x1B, 0x61, 0x00);
    buf.push(...asciiBytes(line));

    const kontLabel = receipt.kontingen.sekolah_nama
      ? `${receipt.kontingen.kode} (${receipt.kontingen.sekolah_nama})`
      : receipt.kontingen.kode;
    buf.push(...asciiBytes(`Pos       : ${receipt.pos.nama}\n`));
    buf.push(...asciiBytes(`Kontingen : ${kontLabel}\n`));
    buf.push(...asciiBytes(line));

    const judges = receipt.juri_breakdown || [];
    if (judges.length <= 1) {
      const j = judges[0];
      if (j) {
        (j.rubrik_nilai || []).forEach((r) => {
          buf.push(...asciiBytes(padLine(r.rubrik_nama, J.formatNum(r.nilai))));
        });
        if (j.komponen_subtotals && (j.komponen_subtotals.Teori !== undefined || j.komponen_subtotals.Praktik !== undefined)) {
          buf.push(...asciiBytes(line));
          if (j.komponen_subtotals.Teori !== undefined) {
            buf.push(...asciiBytes(padLine('Subtotal Teori', J.formatNum(j.komponen_subtotals.Teori))));
          }
          if (j.komponen_subtotals.Praktik !== undefined) {
            buf.push(...asciiBytes(padLine('Subtotal Praktik', J.formatNum(j.komponen_subtotals.Praktik))));
          }
        }
      }
    } else {
      judges.forEach((j, idx) => {
        buf.push(0x1B, 0x45, 0x01);
        buf.push(...asciiBytes(`Juri ${idx + 1}\n`));
        buf.push(0x1B, 0x45, 0x00);
        (j.rubrik_nilai || []).forEach((r) => {
          buf.push(...asciiBytes(padLine('  ' + r.rubrik_nama, J.formatNum(r.nilai))));
        });
        if (j.komponen_subtotals && (j.komponen_subtotals.Teori !== undefined || j.komponen_subtotals.Praktik !== undefined)) {
          if (j.komponen_subtotals.Teori !== undefined) {
            buf.push(...asciiBytes(padLine('  Sub. Teori', J.formatNum(j.komponen_subtotals.Teori))));
          }
          if (j.komponen_subtotals.Praktik !== undefined) {
            buf.push(...asciiBytes(padLine('  Sub. Praktik', J.formatNum(j.komponen_subtotals.Praktik))));
          }
        }
        buf.push(...asciiBytes(padLine(`  Total Juri ${idx + 1}`, J.formatNum(j.total_juri))));
      });
    }

    buf.push(...asciiBytes(line));
    if (receipt.pos.pakai_timer) {
      buf.push(...asciiBytes(padLine('Timer', J.formatTimer(receipt.total_timer))));
    }
    if (receipt.pos.pakai_bidak) {
      buf.push(...asciiBytes(padLine('Bidak', J.formatNum(receipt.bidak))));
    }
    buf.push(0x1B, 0x45, 0x01);
    const labelAkhir = judges.length > 1
      ? `Nilai Akhir (${receipt.pos.cara_gabung === 'jumlah' ? 'Jumlah' : 'Rata2'})`
      : 'TOTAL NILAI';
    buf.push(...asciiBytes(padLine(labelAkhir, J.formatNum(receipt.nilai_akhir))));
    buf.push(0x1B, 0x45, 0x00);
    buf.push(...asciiBytes(line));

    const qrLink = `${window.location.origin}${window.location.pathname.replace(/[^/]+$/, '')}publik.html?kegiatan=${receipt.kegiatan.id}&kontingen=${encodeURIComponent(receipt.kontingen.kode)}&pos=${receipt.pos.id}`;
    buf.push(...buildEscPosQr(qrLink));
    buf.push(0x1B, 0x61, 0x01);
    buf.push(...asciiBytes('Pindai QR untuk cek & unduh PDF\n\n\n\n'));
    buf.push(0x1D, 0x56, 0x00); // Cut if supported
    return new Uint8Array(buf);
  }

  /**
   * Section 17: 50 x 30 mm QR Label TSPL command for BLE thermal label printer
   */
  function buildTsplLabel50x30(kodePeserta) {
    const cmds = [
      'SIZE 50 mm,30 mm',
      'GAP 2 mm,0 mm',
      'DIRECTION 1',
      'CLS',
      `QRCODE 28,24,M,5,A,0,"${kodePeserta}"`,
      `TEXT 195,70,"3",0,1,1,"${kodePeserta}"`,
      'TEXT 195,120,"2",0,1,1,"JUMBARA PMR"',
      'PRINT 1,1',
      '',
    ].join('\r\n');
    return new Uint8Array(asciiBytes(cmds));
  }

  async function printReceipt(receipt, reprintBadge = '') {
    const bytes = buildReceiptBytes(receipt, reprintBadge);
    await writeBytes(bytes);
  }

  async function printLabels50x30(pesertaList) {
    for (const p of pesertaList) {
      await writeBytes(buildTsplLabel50x30(p.kode_peserta));
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  return {
    isSupported,
    getStatus,
    connect,
    printReceipt,
    printLabels50x30,
  };
})();
