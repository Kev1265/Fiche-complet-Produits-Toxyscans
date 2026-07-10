/* =========================================================================
   TOXYSCAN — FULL QR LINK EXTRACTOR (v4)
   Loops through every Site -> Departement -> Sous-departement -> Localisation
   -> Sous-localisation -> Produit combination, and decodes the QR for each.

   KEY FIX vs earlier versions: instead of guessing when the QR image has
   updated by watching its URL (unreliable), this reads the plain-text
   product name inside the label iframe (#label-pdf -> #nom). That element
   updates immediately and reliably, which also fixes the "first product
   always skipped" bug from before.

   WARNING: this can take a LONG time depending on how many
   Sites x Departments x Sous-departments x Localisations x Sous-localisations
   x Produits you have. Keep the tab focused/active while it runs -- some
   browsers slow down timers in background tabs.

   HOW TO USE: paste into DevTools Console (F12) on the label/QR page,
   press Enter, and let it run. It downloads ONE CSV at the very end.
   ========================================================================= */

(async () => {
  const results = [];
  const skippedCombos = [];

  const siteSel   = document.getElementById('site-local');
  const deptSel   = document.getElementById('dept-local');
  const sousSel   = document.getElementById('sous-local');
  const localeSel = document.getElementById('locale-local');
  const subeSel   = document.getElementById('sube-local');
  const prodSel   = document.getElementById('produit');

  if (!siteSel || !deptSel || !sousSel || !localeSel || !subeSel || !prodSel) {
    alert('Erreur : un ou plusieurs menus (site/departement/sous-departement/localisation/sous-localisation/produit) sont introuvables sur cette page.');
    return;
  }

  // ---- Overlay UI ----
  let overlay = document.getElementById('_txy_qr_overlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = '_txy_qr_overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,12,20,.93);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif';
  overlay.innerHTML = '<div style="background:#1a1d26;border:1px solid #2e3247;border-radius:8px;padding:32px 40px;max-width:520px;width:90%;text-align:center">' +
    '<div style="font-size:22px;font-weight:900;color:#f5a623;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Extraction complete (v4)</div>' +
    '<div id="_txy_qr_lbl" style="font-size:13px;color:#7a80a0;margin-bottom:8px">Initialisation...</div>' +
    '<div style="background:#0f1117;border:1px solid #2e3247;border-radius:100px;height:10px;overflow:hidden;margin:10px 0"><div id="_txy_qr_bar" style="background:linear-gradient(90deg,#f5a623,#ffc44d);height:100%;width:0%;border-radius:100px;transition:width .4s"></div></div>' +
    '<div id="_txy_qr_log" style="background:#0f1117;border:1px solid #2e3247;border-radius:6px;padding:12px;height:220px;overflow-y:auto;text-align:left;font-family:monospace;font-size:11px;color:#7a80a0;margin:12px 0;white-space:pre-wrap;word-break:break-all"></div>' +
    '<button onclick="document.getElementById(\'_txy_qr_overlay\').remove()" style="background:none;border:1px solid #2e3247;color:#7a80a0;font-size:13px;font-weight:700;text-transform:uppercase;padding:8px 20px;border-radius:6px;cursor:pointer;margin-top:6px">Fermer</button>' +
    '</div>';
  document.body.appendChild(overlay);

  const lbl = document.getElementById('_txy_qr_lbl');
  const bar = document.getElementById('_txy_qr_bar');
  const log = document.getElementById('_txy_qr_log');
  function addLog(msg) { log.textContent += msg + '\n'; log.scrollTop = log.scrollHeight; }
  function setProgress(pct, label) { bar.style.width = pct + '%'; lbl.textContent = label; }

  // ---- Helpers ----
  function realOptions(selectEl) {
    return [...selectEl.options].filter(o => {
      const v = (o.value || '').trim();
      const t = (o.text || '').trim().toLowerCase();
      if (!v) return false;
      if (t === 'tous' || t === '-' || t === 'aucun') return false;
      return true;
    });
  }

  async function setSelect(el, value, waitMs) {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, waitMs));
  }

  function getLabelFrameDoc() {
    const iframe = document.getElementById('label-pdf');
    if (!iframe) return null;
    try { return iframe.contentDocument || iframe.contentWindow.document; }
    catch (e) { return null; }
  }

  function getCurrentLabelData() {
    const doc = getLabelFrameDoc();
    if (!doc) return null;
    const nomEl = doc.getElementById('nom');
    const qrEl = doc.getElementById('qr');
    const codeEl = doc.getElementById('code');
    const fabricantEl = doc.getElementById('fabricant');
    return {
      nom: nomEl ? nomEl.textContent.trim() : '',
      qrSrc: qrEl ? qrEl.src : '',
      code: codeEl ? codeEl.textContent.trim() : '',
      fabricant: fabricantEl ? fabricantEl.textContent.trim() : ''
    };
  }

  // Waits for the label iframe to show a NEW, non-empty product name+QR
  async function waitForLabelUpdate(lastNom, lastQrSrc, timeoutMs = 6000, intervalMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const data = getCurrentLabelData();
      if (data && data.nom && data.qrSrc && (data.nom !== lastNom || data.qrSrc !== lastQrSrc)) {
        await new Promise(r => setTimeout(r, 350));
        const confirm = getCurrentLabelData();
        if (confirm && confirm.nom === data.nom && confirm.qrSrc === data.qrSrc) return confirm;
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return null;
  }

  async function decodeQr(imgUrl) {
    if (typeof jsQR === 'undefined') {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('jsQR failed to load'));
        document.head.appendChild(s);
      });
    }
    const bustUrl = imgUrl + (imgUrl.includes('?') ? '&' : '?') + '_cb=' + Date.now();
    const resp = await fetch(bustUrl, { credentials: 'include', cache: 'no-store' });
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height);
    return code ? code.data : null;
  }

  const sites = realOptions(siteSel);
  addLog(sites.length + ' site(s) trouve(s). Demarrage...\n');

  let lastNom = null, lastQrSrc = null;
  let comboCount = 0;

  for (const siteOpt of sites) {
    await setSelect(siteSel, siteOpt.value, 1000);
    const depts = realOptions(deptSel);

    for (const deptOpt of depts) {
      await setSelect(deptSel, deptOpt.value, 1000);
      const souss = realOptions(sousSel);
      const sousLoop = souss.length ? souss : [{ value: '', text: '(aucun)' }];

      for (const sousOpt of sousLoop) {
        if (sousOpt.value) await setSelect(sousSel, sousOpt.value, 700);
        const locales = realOptions(localeSel);
        const localeLoop = locales.length ? locales : [{ value: '', text: '(aucun)' }];

        for (const localeOpt of localeLoop) {
          if (localeOpt.value) await setSelect(localeSel, localeOpt.value, 700);
          const subes = realOptions(subeSel);
          const subeLoop = subes.length ? subes : [{ value: '', text: '(aucun)' }];

          for (const subeOpt of subeLoop) {
            if (subeOpt.value) await setSelect(subeSel, subeOpt.value, 700);

            const prods = realOptions(prodSel);
            comboCount++;
            const comboLabel = [siteOpt.text, deptOpt.text, sousOpt.text, localeOpt.text, subeOpt.text].join(' > ');
            setProgress(Math.min(95, comboCount % 100), 'Combo #' + comboCount + ': ' + comboLabel);

            if (prods.length === 0) {
              skippedCombos.push(comboLabel);
              continue;
            }

            addLog('\n--- ' + comboLabel + ' (' + prods.length + ' produits) ---');

            for (const prodOpt of prods) {
              await setSelect(prodSel, prodOpt.value, 0);
              const data = await waitForLabelUpdate(lastNom, lastQrSrc);
              if (!data) {
                results.push({
                  site: siteOpt.text, dept: deptOpt.text, sous: sousOpt.text,
                  locale: localeOpt.text, sube: subeOpt.text,
                  produit: prodOpt.text, link: '', status: 'Timeout - non detecte'
                });
                addLog('  SKIP ' + prodOpt.text + ' — non detecte');
                continue;
              }
              lastNom = data.nom;
              lastQrSrc = data.qrSrc;

              try {
                const decoded = await decodeQr(data.qrSrc);
                results.push({
                  site: siteOpt.text, dept: deptOpt.text, sous: sousOpt.text,
                  locale: localeOpt.text, sube: subeOpt.text,
                  produit: prodOpt.text, link: decoded || '', status: decoded ? 'OK' : 'Decodage echoue'
                });
                addLog('  ' + (decoded ? 'OK' : 'ECHEC') + ' ' + prodOpt.text);
              } catch (e) {
                results.push({
                  site: siteOpt.text, dept: deptOpt.text, sous: sousOpt.text,
                  locale: localeOpt.text, sube: subeOpt.text,
                  produit: prodOpt.text, link: '', status: 'Erreur: ' + e.message
                });
                addLog('  ERREUR ' + prodOpt.text + ': ' + e.message);
              }
            }
          }
        }
      }
    }
  }

  // ---- Build and download CSV ----
  setProgress(100, 'Generation du fichier CSV...');
  const header = 'Site,Departement,Sous-departement,Localisation,Sous-localisation,Produit,Decoded Link,Status\n';
  const rows = results.map(r => {
    const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
    return [esc(r.site), esc(r.dept), esc(r.sous), esc(r.locale), esc(r.sube), esc(r.produit), esc(r.link), esc(r.status)].join(',');
  }).join('\n');
  const csv = header + rows;

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'toxyscan_full_extraction.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);

  const okCount = results.filter(r => r.status === 'OK').length;
  addLog('\n' + '='.repeat(40));
  addLog('Combos traites   : ' + comboCount);
  addLog('Combos vides     : ' + skippedCombos.length);
  addLog('Liens OK         : ' + okCount + ' / ' + results.length);
  addLog('Fichier telecharge : toxyscan_full_extraction.csv');
  addLog('='.repeat(40));
})();
