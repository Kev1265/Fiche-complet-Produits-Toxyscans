/* =========================================================================
   TOXYSCAN — AUTO-QUEUE QR LINK EXTRACTOR, BY SITE, WITH DEDUP (v9)
   -------------------------------------------------------------------------
   Same auto-queue-by-site system as before, PLUS: keeps a permanent
   "known products" dictionary (name -> decoded link) in localStorage that
   grows across every run, every site, every reload. Before processing any
   product, it checks this dictionary first -- if the product's name was
   already captured (from this site or any earlier one), it's instantly
   reused with NO wait/decode needed. Only genuinely new product names
   trigger the slow wait+decode cycle.

   This means each successive site gets faster (most products repeat
   across locations), AND you get a perfectly deduplicated master list for
   free -- no merging CSVs by hand.

   TO EXPORT THE MASTER DEDUPLICATED LIST at any time (even mid-run,
   even without the Toxyscan page open, as long as it's the same browser
   profile), run this separately in the console:

     (function(){
       const d = JSON.parse(localStorage.getItem('txy_known_products') || '{}');
       const rows = Object.entries(d).map(([name,link]) =>
         '"' + name.replace(/"/g,'""') + '","' + String(link).replace(/"/g,'""') + '"');
       const csv = 'Product Name,Decoded Link\n' + rows.join('\n');
       const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
       const a = document.createElement('a');
       a.href = URL.createObjectURL(blob);
       a.download = 'toxyscan_MASTER_DEDUP.csv';
       document.body.appendChild(a); a.click(); document.body.removeChild(a);
       console.log(Object.keys(d).length + ' produits uniques exportes.');
     })();

   TO RESET the known-products dictionary (start deduping from scratch):
     localStorage.removeItem('txy_known_products');

   TO RESET the site queue (start site progression from scratch):
     localStorage.removeItem('txy_site_queue');

   HOW TO USE: paste into DevTools Console (F12) / click your bookmark.
   Repeat after each auto-reload.
   ========================================================================= */

(async () => {
  const STORAGE_KEY = 'txy_site_queue';
  const PRODUCTS_KEY = 'txy_known_products';
  const SKIPPED_KEY = 'txy_skipped_products';

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
    el.focus();
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
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

  // ---- Load or build the site queue ----
  let queue = null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) queue = JSON.parse(saved);
  } catch (e) { queue = null; }

  if (!queue) {
    const sites = realOptions(siteSel);
    queue = {
      currentIndex: 0,
      sites: sites.map(s => ({ value: s.value, text: s.text }))
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    addLog('Nouvelle file creee : ' + queue.sites.length + ' site(s) au total.\n');
  }

  if (queue.currentIndex >= queue.sites.length) {
    title.textContent = 'TERMINE !';
    addLog('Tous les sites ont ete traites (' + queue.sites.length + ' au total).');
    addLog('\nPour recommencer depuis le debut, executez dans la console :');
    addLog("localStorage.removeItem('" + STORAGE_KEY + "');");
    return;
  }

  const currentSite = queue.sites[queue.currentIndex];
  title.textContent = (queue.currentIndex + 1) + ' / ' + queue.sites.length;
  addLog(currentSite.text + '\n');

  // ---- Load the persistent known-products dictionary ----
  let knownProducts = {};
  try {
    const savedProducts = localStorage.getItem(PRODUCTS_KEY);
    if (savedProducts) knownProducts = JSON.parse(savedProducts);
  } catch (e) { knownProducts = {}; }
  addLog(Object.keys(knownProducts).length + ' produit(s) deja connus (seront reutilises sans re-scan)\n');

  function saveKnownProducts() {
    try { localStorage.setItem(PRODUCTS_KEY, JSON.stringify(knownProducts)); }
    catch (e) { addLog('ATTENTION : impossible de sauvegarder le dictionnaire (stockage plein?)'); }
  }

  // ---- Load the persistent "still failing" list (survives across runs/passes) ----
  let skippedProducts = {};
  try {
    const savedSkips = localStorage.getItem(SKIPPED_KEY);
    if (savedSkips) skippedProducts = JSON.parse(savedSkips);
  } catch (e) { skippedProducts = {}; }

  function saveSkippedProducts() {
    try { localStorage.setItem(SKIPPED_KEY, JSON.stringify(skippedProducts)); }
    catch (e) { /* non-critical */ }
  }

  // ---- Extraction helpers ----
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
      return {
        nom: nomEl ? nomEl.textContent.trim() : '',
        qrSrc: qrEl ? qrEl.src : '',
        qrReady: !!(qrEl && qrEl.complete && qrEl.naturalWidth > 0)
      };
    } catch (e) { lastIframeError = 'Erreur lecture iframe: ' + e.message; return null; }
  }

  async function waitForLabelStable(timeoutMs = 1000, intervalMs = 150, nameStableChecks = 2) {
    const start = Date.now();
    let lastNom = null, nomStableCount = 0, forcedReload = false, lastSeenNom = '';

    while (Date.now() - start < timeoutMs) {
      const doc = getLabelFrameDoc();
      if (doc) {
        try {
          const nomEl = doc.getElementById('nom');
          const qrEl = doc.getElementById('qr');
          const nom = nomEl ? nomEl.textContent.trim() : '';
          if (nom) lastSeenNom = nom;

          if (nom && nom === lastNom) nomStableCount++;
          else { lastNom = nom; nomStableCount = nom ? 1 : 0; }

          // Once the product NAME is confirmed stable (server has definitely
          // registered the selection), check if the image actually loaded.
          if (nom && nomStableCount >= nameStableChecks) {
            const qrReady = !!(qrEl && qrEl.complete && qrEl.naturalWidth > 0);
            if (qrReady) {
              return { nom, qrSrc: qrEl.src };
            }
            // Name is confirmed correct but image never loaded -- the image
            // request likely fired before the server had registered the
            // selection. Force one fresh request now that we KNOW the
            // server-side state is correct.
            if (qrEl && !forcedReload) {
              forcedReload = true;
              const base = qrEl.src.split('?')[0];
              qrEl.src = base + '?_forcereload=' + Date.now();
            }
          }
        } catch (e) { lastIframeError = 'Erreur lecture iframe: ' + e.message; }
      }
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

  await setSelect(siteSel, currentSite.value, 1200);
  const depts = realOptions(deptSel);
  addLog(depts.length + ' departement(s) a traiter\n');
  let comboCount = 0;

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
          const comboLabel = [deptOpt.text, sousOpt.text, localeOpt.text, subeOpt.text].join(' > ');
          setProgress(Math.min(95, comboCount * 3), comboLabel);
          if (prods.length === 0) continue;

          addLog('\n--- ' + comboLabel + ' (' + prods.length + ' produits) ---');

          for (const prodOpt of prods) {
            const productKey = prodOpt.text.trim();

            // ---- Dedup shortcut: skip the slow wait/decode entirely if we already have this product ----
            if (Object.prototype.hasOwnProperty.call(knownProducts, productKey)) {
              results.push({ dept: deptOpt.text, sous: sousOpt.text, locale: localeOpt.text, sube: subeOpt.text, produit: prodOpt.text, link: knownProducts[productKey], status: 'OK (connu)' });
              addLog('  CONNU ' + prodOpt.text);
              continue;
            }

            await setSelect(prodSel, prodOpt.value, 400);
            const data = await waitForLabelStable();

            if (!data || data._timedOut) {
              results.push({ dept: deptOpt.text, sous: sousOpt.text, locale: localeOpt.text, sube: subeOpt.text, produit: prodOpt.text, link: '', status: 'Timeout - non detecte' });
              addLog('  SKIP ' + prodOpt.text);
              skippedProducts[productKey] = {
                siteValue: currentSite.value, siteText: currentSite.text,
                deptValue: deptOpt.value, deptText: deptOpt.text,
                sousValue: sousOpt.value, sousText: sousOpt.text,
                localeValue: localeOpt.value, localeText: localeOpt.text,
                subeValue: subeOpt.value, subeText: subeOpt.text,
                prodValue: prodOpt.value, prodText: prodOpt.text
              };
              saveSkippedProducts();
              await new Promise(r => setTimeout(r, 100));
              continue;
            }

            try {
              const decoded = await decodeQr(data.qrSrc);
              results.push({ dept: deptOpt.text, sous: sousOpt.text, locale: localeOpt.text, sube: subeOpt.text, produit: prodOpt.text, link: decoded || '', status: decoded ? 'OK' : 'Decodage echoue' });
              if (decoded) {
                knownProducts[productKey] = decoded;
                saveKnownProducts();
                if (skippedProducts[productKey]) {
                  delete skippedProducts[productKey];
                  saveSkippedProducts();
                }
              } else {
                skippedProducts[productKey] = {
                  siteValue: currentSite.value, siteText: currentSite.text,
                  deptValue: deptOpt.value, deptText: deptOpt.text,
                  sousValue: sousOpt.value, sousText: sousOpt.text,
                  localeValue: localeOpt.value, localeText: localeOpt.text,
                  subeValue: subeOpt.value, subeText: subeOpt.text,
                  prodValue: prodOpt.value, prodText: prodOpt.text
                };
                saveSkippedProducts();
              }
              addLog('  ' + (decoded ? 'OK' : 'ECHEC') + ' ' + prodOpt.text);
            } catch (e) {
              results.push({ dept: deptOpt.text, sous: sousOpt.text, locale: localeOpt.text, sube: subeOpt.text, produit: prodOpt.text, link: '', status: 'Erreur: ' + e.message });
              addLog('  ERREUR ' + prodOpt.text + ': ' + e.message);
            }
            await new Promise(r => setTimeout(r, 700));
          }
        }
      }
    }
  }

  // ---- Download CSV for this site ----
  setProgress(100, 'Termine — generation du CSV...');
  const header = 'Site,Departement,Sous-departement,Localisation,Sous-localisation,Produit,Decoded Link,Status\n';
  const rows = results.map(r => {
    const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
    return [esc(currentSite.text), esc(r.dept), esc(r.sous), esc(r.locale), esc(r.sube), esc(r.produit), esc(r.link), esc(r.status)].join(',');
  }).join('\n');
  const csv = header + rows;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  const safeName = currentSite.text.trim().replace(/[\\\/*?:"<>|]/g, '_').slice(0, 80);
  a.href = URL.createObjectURL(blob);
  a.download = 'toxyscan_' + String(queue.currentIndex + 1).padStart(3, '0') + '_' + safeName + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);

  // ---- Advance the queue and save ----
  queue.currentIndex += 1;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));

  const okCount = results.filter(r => r.status === 'OK' || r.status === 'OK (connu)').length;
  const reusedCount = results.filter(r => r.status === 'OK (connu)').length;
  const newCount = results.filter(r => r.status === 'OK').length;
  const skippedThisRun = results.filter(r => r.status !== 'OK' && r.status !== 'OK (connu)').length;
  addLog('\n' + '='.repeat(40));
  addLog('Termine : ' + currentSite.text);
  addLog('Produits traites : ' + results.length);
  addLog('  -> OK : ' + okCount + ' (' + reusedCount + ' reutilises, ' + newCount + ' nouveaux)');
  addLog('  -> Ignores (skip) : ' + skippedThisRun);
  addLog('Progres global : ' + queue.currentIndex + ' / ' + queue.sites.length + ' sites');
  addLog('Dictionnaire maitre : ' + Object.keys(knownProducts).length + ' produits uniques reussis au total');
  addLog('Produits encore en echec (toutes passes confondues) : ' + Object.keys(skippedProducts).length);
  addLog('='.repeat(40));

  if (queue.currentIndex >= queue.sites.length) {
    addLog('\nTOUS les sites sont termines ! Aucun autre rechargement.');
    addLog('\n--- RESUME FINAL ---');
    addLog('Produits uniques reussis : ' + Object.keys(knownProducts).length);
    addLog('Produits toujours en echec : ' + Object.keys(skippedProducts).length);
    if (Object.keys(skippedProducts).length > 0) {
      addLog('\nListe des produits encore en echec :');
      Object.keys(skippedProducts).forEach(name => addLog('  - ' + name));
      addLog('\nConseil : videz la file (txy_site_queue) et relancez une autre');
      addLog('passe -- seuls ces produits restants prendront du temps, le reste');
      addLog('sera instantane grace au dictionnaire deja rempli.');
    }
  } else {
    addLog('\nRechargement automatique dans 5 secondes... cliquez sur le signet apres le rechargement pour continuer.');
    await new Promise(r => setTimeout(r, 5000));
    location.reload();
  }
})();
