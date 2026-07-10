/* =========================================================================
   TOXYSCAN — QR CODE LINK EXTRACTOR (v2 — fixes stale-image bug)
   -------------------------------------------------------------------------
   WHAT CHANGED FROM v1:
   - v1 grabbed the QR image as soon as ANY matching <img> was found, which
     was often still the PREVIOUS product's cached image (page hadn't
     swapped yet). This version tracks the last-seen image URL and waits
     until it actually CHANGES before decoding, and adds a cache-busting
     query param + extra settle time so we're never reading a stale image.

   HOW TO USE: same as before — go to the product dropdown page, open
   DevTools Console (F12), paste this whole script, press Enter.
   ========================================================================= */

(async () => {
  if (typeof jsQR === 'undefined') {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('jsQR failed to load'));
      document.head.appendChild(s);
    });
  }

  const results = [];

  const select = document.getElementById('produit')
              || document.querySelector('#selecteur select')
              || document.querySelector('select');
  if (!select) {
    alert('Erreur : liste de produits introuvable sur cette page.\nAssurez-vous d\'etre sur la bonne page Toxyscan.');
    return;
  }

  const options = [...select.options].filter(o => o.value && o.value !== '0');
  const total = options.length;
  if (total === 0) { alert('Aucun produit trouve dans la liste.'); return; }

  // ---- Overlay UI ----
  let overlay = document.getElementById('_txy_qr_overlay');
  if (overlay) overlay.remove(); // fresh overlay each run
  overlay = document.createElement('div');
  overlay.id = '_txy_qr_overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,12,20,.93);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif';
  overlay.innerHTML = '<div style="background:#1a1d26;border:1px solid #2e3247;border-radius:8px;padding:32px 40px;max-width:480px;width:90%;text-align:center">' +
    '<div style="font-size:22px;font-weight:900;color:#f5a623;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Extraction des liens QR (v3)</div>' +
    '<div id="_txy_qr_lbl" style="font-size:13px;color:#7a80a0;margin-bottom:8px">Initialisation...</div>' +
    '<div style="background:#0f1117;border:1px solid #2e3247;border-radius:100px;height:10px;overflow:hidden;margin:10px 0"><div id="_txy_qr_bar" style="background:linear-gradient(90deg,#f5a623,#ffc44d);height:100%;width:0%;border-radius:100px;transition:width .4s"></div></div>' +
    '<div id="_txy_qr_log" style="background:#0f1117;border:1px solid #2e3247;border-radius:6px;padding:12px;height:180px;overflow-y:auto;text-align:left;font-family:monospace;font-size:11px;color:#7a80a0;margin:12px 0;white-space:pre-wrap;word-break:break-all"></div>' +
    '<button onclick="document.getElementById(\'_txy_qr_overlay\').remove()" style="background:none;border:1px solid #2e3247;color:#7a80a0;font-size:13px;font-weight:700;text-transform:uppercase;padding:8px 20px;border-radius:6px;cursor:pointer;margin-top:6px">Fermer</button>' +
    '</div>';
  document.body.appendChild(overlay);

  const lbl = document.getElementById('_txy_qr_lbl');
  const bar = document.getElementById('_txy_qr_bar');
  const log = document.getElementById('_txy_qr_log');

  function addLog(msg) { log.textContent += msg + '\n'; log.scrollTop = log.scrollHeight; }
  function setProgress(pct, label) { bar.style.width = pct + '%'; lbl.textContent = label; }

  function findQrImg() {
    const direct = document.querySelector('img[src*="/qr/lien/"]');
    if (direct) return direct;
    const iframes = document.querySelectorAll('iframe');
    for (const frame of iframes) {
      try {
        const doc = frame.contentDocument || frame.contentWindow.document;
        const img = doc.querySelector('img[src*="/qr/lien/"]');
        if (img) return img;
      } catch (e) {}
    }
    return null;
  }

  // Wait until the QR image URL is DIFFERENT from the last one we saw
  async function waitForNewQrSrc(lastSrc, timeoutMs = 6000, intervalMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const img = findQrImg();
      if (img && img.src && img.src !== lastSrc) {
        // extra settle time to make sure the browser isn't mid-swap
        await new Promise(r => setTimeout(r, 400));
        const confirmImg = findQrImg();
        if (confirmImg && confirmImg.src === img.src) return img.src;
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return null;
  }

  async function decodeQr(imgUrl) {
    // cache-bust so we never read a browser-cached (stale) version
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

  addLog(total + ' produits trouves — demarrage (v3, avec detection de changement)...\n');

  // Force the dropdown to a blank/neutral state first. Without this, if the
  // page already defaults to showing product #1, selecting it "again" never
  // triggers a visible change, so product #1 would incorrectly time out.
  const blankOption = [...select.options].find(o => !o.value || o.value === '0');
  if (blankOption) {
    select.value = blankOption.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
  }

  let lastSrc = null;
  const initialImg = findQrImg();
  if (initialImg) lastSrc = initialImg.src;

  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const name = opt.text.trim();
    setProgress(Math.round((i / total) * 90), 'Traitement ' + (i + 1) + '/' + total + ' : ' + name);

    select.value = opt.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.dispatchEvent(new Event('input', { bubbles: true }));

    const newSrc = await waitForNewQrSrc(lastSrc);
    if (!newSrc) {
      results.push({ name, link: '', imgUrl: '', status: 'Image QR inchangee/introuvable' });
      addLog('SKIP [' + (i + 1) + '/' + total + '] ' + name + ' — pas de nouvelle image detectee');
      continue;
    }
    lastSrc = newSrc;

    try {
      const decoded = await decodeQr(newSrc);
      if (decoded) {
        results.push({ name, link: decoded, imgUrl: newSrc, status: 'OK' });
        addLog('OK [' + (i + 1) + '/' + total + '] ' + name);
      } else {
        results.push({ name, link: '', imgUrl: newSrc, status: 'Decodage echoue' });
        addLog('ECHEC DECODAGE [' + (i + 1) + '/' + total + '] ' + name);
      }
    } catch (e) {
      results.push({ name, link: '', imgUrl: newSrc, status: 'Erreur: ' + e.message });
      addLog('ERREUR [' + (i + 1) + '/' + total + '] ' + name + ': ' + e.message);
    }
  }

  setProgress(95, 'Generation du fichier CSV...');
  const header = 'Product Name,Decoded Link,QR Image URL,Status\n';
  const rows = results.map(r => {
    const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
    return [esc(r.name), esc(r.link), esc(r.imgUrl), esc(r.status)].join(',');
  }).join('\n');
  const csv = header + rows;

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'toxyscan_qr_links_v2.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);

  const okCount = results.filter(r => r.status === 'OK').length;
  const uniqueLinks = new Set(results.filter(r => r.status === 'OK').map(r => r.link)).size;
  setProgress(100, 'Termine !');
  addLog('\n' + '='.repeat(40));
  addLog('Liens extraits avec succes : ' + okCount + ' / ' + total);
  addLog('Liens UNIQUES trouves      : ' + uniqueLinks);
  addLog('Fichier CSV telecharge : toxyscan_qr_links_v2.csv');
  addLog('='.repeat(40));
  if (uniqueLinks < okCount * 0.5) {
    addLog('\nATTENTION : beaucoup de liens semblent identiques.');
    addLog('Le probleme de detection pourrait persister — verifiez');
    addLog('manuellement quelques lignes du CSV avant de continuer.');
  }
})();
