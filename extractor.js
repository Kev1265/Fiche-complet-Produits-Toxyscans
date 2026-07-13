/* =========================================================================
   TOXYSCAN — AUTO-QUEUE QR LINK EXTRACTOR (v7)
   -------------------------------------------------------------------------
   Remembers its place across page reloads using localStorage. No more
   picking Site/Departement each time -- just click the bookmark, let it
   process one combo, it reloads itself, then click the bookmark again for
   the next one.

   FIRST RUN: builds a full queue of every Site x Departement combination
   (this takes a minute or two by itself, just iterating the dropdowns --
   no product processing yet). Saves it to localStorage.

   EVERY RUN AFTER: picks up the next un-processed combo in the queue,
   extracts it, downloads a CSV, marks it done, reloads the page.

   WHEN FINISHED: once every combo is done, it tells you and stops
   reloading.

   TO RESET (start over from combo #1): run this in the console:
     localStorage.removeItem('txy_extraction_queue');

   TO CHECK PROGRESS at any time: run this in the console:
     JSON.parse(localStorage.getItem('txy_extraction_queue')).currentIndex

   HOW TO USE: paste into DevTools Console (F12), press Enter (or click
   your bookmark). Repeat after each auto-reload.
   ========================================================================= */

(async () => {
  const STORAGE_KEY = 'txy_extraction_queue';

  const siteSel   = document.getElementById('site-local');
  const deptSel   = document.getElementById('dept-local');
  const sousSel   = document.getElementById('sous-local');
  const localeSel = document.getElementById('locale-local');
  const subeSel   = document.getElementById('sube-local');
  const prodSel   = document.getElementById('produit');

  if (!siteSel || !deptSel || !sousSel || !localeSel || !subeSel || !prodSel) {
    alert('Erreur : un ou plusieurs menus sont introuvables sur cette page.');
    return;
  }

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

  let overlay = document.getElementById('_txy_qr_overlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = '_txy_qr_overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,12,20,.93);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif';
  overlay.innerHTML = '<div style="background:#1a1d26;border:1px solid #2e3247;border-radius:8px;padding:32px 40px;max-width:520px;width:90%;text-align:center">' +
    '<div id="_txy_qr_title" style="font-size:18px;font-weight:900;color:#f5a623;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Initialisation...</div>' +
    '<div id="_txy_qr_lbl" style="font-size:13px;color:#7a80a0;margin-bottom:8px"></div>' +
    '<div style="background:#0f1117;border:1px solid #2e3247;border-radius:100px;height:10px;overflow:hidden;margin:10px 0"><div id="_txy_qr_bar" style="background:linear-gradient(90deg,#f5a623,#ffc44d);height:100%;width:0%;border-radius:100px;transition:width .4s"></div></div>' +
    '<div id="_txy_qr_log" style="background:#0f1117;border:1px solid #2e3247;border-radius:6px;padding:12px;height:260px;overflow-y:auto;text-align:left;font-family:monospace;font-size:11px;color:#7a80a0;margin:12px 0;white-space:pre-wrap;word-break:break-all"></div>' +
    '</div>';
  document.body.appendChild(overlay);

  const title = document.getElementById('_txy_qr_title');
  const lbl = document.getElementById('_txy_qr_lbl');
  const bar = document.getElementById('_txy_qr_bar');
  const log = document.getElementById('_txy_qr_log');
  function addLog(msg) { log.textContent += msg + '\n'; log.scrollTop = log.scrollHeight; }
  function setProgress(pct, label) { bar.style.width = pct + '%'; lbl.textContent = label; }

  // ---- Load or build the queue ----
  let queue = null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) queue = JSON.parse(saved);
  } catch (e) { queue = null; }

  if (!queue) {
    title.textContent = 'Construction de la liste (une seule fois)';
    addLog('Aucune file trouvee — construction de la liste complete Site x Departement...\n');
    const sites = realOptions(siteSel);
    const combos = [];
    for (let i = 0; i < sites.length; i++) {
      const s = sites[i];
      setProgress(Math.round((i / sites.length) * 100), 'Lecture des departements : ' + s.text);
      await setSelect(siteSel, s.value, 900);
      const depts = realOptions(deptSel);
      for (const d of depts) {
        combos.push({ siteValue: s.value, siteText: s.text, deptValue: d.value, deptText: d.text });
      }
      addLog('OK ' + s.text + ' (' + depts.length + ' departement(s))');
    }
    queue = { currentIndex: 0, combos };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    addLog('\nFile construite : ' + combos.length + ' combinaison(s) Site x Departement au total.\n');
  }

  if (queue.currentIndex >= queue.combos.length) {
    title.textContent = 'TERMINE !';
    addLog('Toutes les combinaisons ont ete traitees (' + queue.combos.length + ' au total).');
    addLog('\nPour recommencer depuis le debut, executez dans la console :');
    addLog("localStorage.removeItem('" + STORAGE_KEY + "');");
    return;
  }

  const current = queue.combos[queue.currentIndex];
  title.textContent = (queue.currentIndex + 1) + ' / ' + queue.combos.length;
  addLog(current.siteText + ' > ' + current.deptText + '\n');

  // ---- Extraction logic (same as before) ----
  let lastIframeError = '';
  function getLabelFrameDoc() {
    const iframe = document.getElementById('label-pdf');
    if (!iframe) { lastIframeError = 'iframe #label-pdf introuvable'; return null; }
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      lastIframeError = '';
      return doc;
    } catch (e) { lastIframeError = 'Erreur acces iframe: ' + e.message; return null; }
  }

  function getCurrentLabelData() {
    const doc = getLabelFrameDoc();
    if (!doc) return null;
    try {
      const nomEl = doc.getElementById('nom');
      const qrEl = doc.getElementById('qr');
      return { nom: nomEl ? nomEl.textContent.trim() : '', qrSrc: qrEl ? qrEl.src : '' };
    } catch (e) { lastIframeError = 'Erreur lecture iframe: ' + e.message; return null; }
  }

  async function waitForLabelStable(timeoutMs = 12000, intervalMs = 250, stableChecks = 2) {
    const start = Date.now();
    let lastKey = null, stableCount = 0, lastSeenNom = '';
    while (Date.now() - start < timeoutMs) {
      const data = getCurrentLabelData();
      if (data && data.nom) lastSeenNom = data.nom;
      if (data && data.nom && data.qrSrc) {
        const key = data.nom + '|' + data.qrSrc;
        if (key === lastKey) { stableCount++; if (stableCount >= stableChecks) return data; }
        else { lastKey = key; stableCount = 1; }
      } else { lastKey = null; stableCount = 0; }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return { _timedOut: true, _lastSeenNom: lastSeenNom, _lastError: lastIframeError };
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

  const results = [];

  await setSelect(siteSel, current.siteValue, 1200);
  await setSelect(deptSel, current.deptValue, 1000);
  const souss = realOptions(sousSel);
  const sousLoop = souss.length ? souss : [{ value: '', text: '(aucun)' }];
  let comboCount = 0;

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
        const comboLabel = [sousOpt.text, localeOpt.text, subeOpt.text].join(' > ');
        setProgress(Math.min(95, comboCount * 5), comboLabel);
        if (prods.length === 0) continue;

        addLog('\n--- ' + comboLabel + ' (' + prods.length + ' produits) ---');

        for (const prodOpt of prods) {
          await setSelect(prodSel, prodOpt.value, 400);
          let data = await waitForLabelStable();

          if (data && data._timedOut) {
            await setSelect(prodSel, prodOpt.value, 500);
            data = await waitForLabelStable();
          }

          if (!data || data._timedOut) {
            results.push({ sous: sousOpt.text, locale: localeOpt.text, sube: subeOpt.text, produit: prodOpt.text, link: '', status: 'Timeout - non detecte' });
            addLog('  SKIP ' + prodOpt.text);
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }

          try {
            const decoded = await decodeQr(data.qrSrc);
            results.push({ sous: sousOpt.text, locale: localeOpt.text, sube: subeOpt.text, produit: prodOpt.text, link: decoded || '', status: decoded ? 'OK' : 'Decodage echoue' });
            addLog('  ' + (decoded ? 'OK' : 'ECHEC') + ' ' + prodOpt.text);
          } catch (e) {
            results.push({ sous: sousOpt.text, locale: localeOpt.text, sube: subeOpt.text, produit: prodOpt.text, link: '', status: 'Erreur: ' + e.message });
            addLog('  ERREUR ' + prodOpt.text + ': ' + e.message);
          }
          await new Promise(r => setTimeout(r, 700));
        }
      }
    }
  }

  // ---- Download CSV for this combo ----
  setProgress(100, 'Termine — generation du CSV...');
  const header = 'Site,Departement,Sous-departement,Localisation,Sous-localisation,Produit,Decoded Link,Status\n';
  const rows = results.map(r => {
    const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
    return [esc(current.siteText), esc(current.deptText), esc(r.sous), esc(r.locale), esc(r.sube), esc(r.produit), esc(r.link), esc(r.status)].join(',');
  }).join('\n');
  const csv = header + rows;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  const safeName = (current.siteText + '_' + current.deptText).trim().replace(/[\\\/*?:"<>|]/g, '_').slice(0, 80);
  a.href = URL.createObjectURL(blob);
  a.download = 'toxyscan_' + String(queue.currentIndex + 1).padStart(3, '0') + '_' + safeName + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);

  // ---- Advance the queue and save ----
  queue.currentIndex += 1;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));

  const okCount = results.filter(r => r.status === 'OK').length;
  addLog('\n' + '='.repeat(40));
  addLog('Termine : ' + current.siteText + ' > ' + current.deptText);
  addLog('Liens OK : ' + okCount + ' / ' + results.length);
  addLog('Progres global : ' + queue.currentIndex + ' / ' + queue.combos.length);
  addLog('='.repeat(40));

  if (queue.currentIndex >= queue.combos.length) {
    addLog('\nTOUTES les combinaisons sont terminees ! Aucun autre rechargement.');
  } else {
    addLog('\nRechargement automatique dans 5 secondes... cliquez sur le signet apres le rechargement pour continuer.');
    await new Promise(r => setTimeout(r, 5000));
    location.reload();
  }
})();
