(() => {
  const dropZone    = document.getElementById('drop-zone');
  const fileInput   = document.getElementById('file-input');
  const previewImg  = document.getElementById('preview-img');
  const origPh      = document.getElementById('orig-ph');
  const svgPreview  = document.getElementById('svg-preview');
  const vecPh       = document.getElementById('vec-ph');
  const errorBox    = document.getElementById('error-box');
  const metaBar     = document.getElementById('meta-bar');
  const actions     = document.getElementById('actions');
  const downloadBtn = document.getElementById('download-btn');
  const resetBtn    = document.getElementById('reset-btn');
  const canvas      = document.getElementById('canvas');
  const spinner     = document.getElementById('spinner');
  const urlInput    = document.getElementById('url-input');
  const urlSubmit   = document.getElementById('url-submit');
  const ctx         = canvas.getContext('2d', { willReadFrequently: true });

  // ── Tab switching ────────────────────────────────────────────────────────

  window.switchTab = function(tab) {
    document.getElementById('panel-upload').style.display = tab === 'upload' ? 'block' : 'none';
    document.getElementById('panel-url').classList.toggle('visible', tab === 'url');
    document.getElementById('tab-upload').classList.toggle('active', tab === 'upload');
    document.getElementById('tab-url').classList.toggle('active', tab === 'url');
  };

  // ── Event wiring ────────────────────────────────────────────────────────

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => e.target.files[0] && processFile(e.target.files[0]));
  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) processFile(f);
  });

  urlSubmit.addEventListener('click', generateFromUrl);
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') generateFromUrl(); });

  resetBtn.addEventListener('click', reset);

  // ── Generate QR from URL/text ────────────────────────────────────────────

  function generateFromUrl() {
    let text = urlInput.value.trim();
    if (!text) return;

    // Auto-prepend https:// if it looks like a bare domain
    if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(text) && !/^https?:\/\//i.test(text)) {
      text = 'https://' + text;
      urlInput.value = text;
    }

    reset(false);
    showSpinner();

    try {
      // qrcode-generator: type=0 means auto type number, 'M' = error correction
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();

      const moduleCount = qr.getModuleCount();
      const version = (moduleCount - 17) / 4;

      // Build grid directly from qrcode-generator — no pixel sampling needed
      const grid = [];
      for (let r = 0; r < moduleCount; r++) {
        const row = [];
        for (let c = 0; c < moduleCount; c++) {
          row.push(qr.isDark(r, c) ? 1 : 0);
        }
        grid.push(row);
      }

      // Draw to canvas so we can show a raster preview
      const scale = 8;
      const quiet = 4;
      const totalModules = moduleCount + quiet * 2;
      canvas.width  = totalModules * scale;
      canvas.height = totalModules * scale;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000000';
      for (let r = 0; r < moduleCount; r++) {
        for (let c = 0; c < moduleCount; c++) {
          if (grid[r][c]) {
            ctx.fillRect((quiet + c) * scale, (quiet + r) * scale, scale, scale);
          }
        }
      }

      // Show raster preview
      origPh.style.display     = 'none';
      previewImg.src           = canvas.toDataURL();
      previewImg.style.display = 'block';
      errorBox.style.display   = 'none';

      finishPipeline(grid, version, text);

    } catch (err) {
      hideSpinner();
      showError('Error generating QR code: ' + err.message);
      console.error(err);
    }
  }

  // ── File processing ──────────────────────────────────────────────────────

  function processFile(file) {
    reset(false);
    const reader = new FileReader();
    reader.onload = e => {
      showImagePreview(e.target.result);
      showSpinner();
      const img = new Image();
      img.onload = () => setTimeout(() => runPipeline(img), 60);
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }


  // ── Pipeline ─────────────────────────────────────────────────────────────

  function runPipeline(img) {
    try {
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;

      // Always composite onto white first — handles transparent PNGs correctly
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // First try jsQR (works for clean QR codes)
      let code =
        jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' }) ||
        jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: 'onlyInvert' });

      // Also try on a contrast-boosted version (helps with logos / low contrast)
      if (!code || !code.location) {
        const boosted = boostContrast(imageData);
        code =
          jsQR(boosted.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' }) ||
          jsQR(boosted.data, canvas.width, canvas.height, { inversionAttempts: 'onlyInvert' }) ||
          code;
      }

      let grid, version, decoded = '';

      if (code && code.location && code.location.topLeftCorner) {
        // Happy path — jsQR found it fully
        version = code.version;
        const gridSize = 4 * version + 17;
        grid = unwarpAndSample(code.location, gridSize);
        decoded = code.data || '';
      } else {
        // Fallback — locate grid via finder patterns, no decode needed
        const result = findGridViaFinderPatterns(imageData);
        if (!result) {
          hideSpinner();
          showError('Could not detect the QR code grid. Try a clearer image with stronger contrast between the modules and background.');
          return;
        }
        grid    = result.grid;
        version = (grid.length - 17) / 4;
      }

      finishPipeline(grid, version, decoded);

    } catch (err) {
      hideSpinner();
      showError('Error: ' + err.message);
      console.error(err);
    }
  }

  // Boost contrast to help jsQR see through logos
  function boostContrast(imageData) {
    const src  = imageData.data;
    const out  = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i += 4) {
      const lum = 0.299 * src[i] + 0.587 * src[i+1] + 0.114 * src[i+2];
      const v   = lum < 160 ? 0 : 255;
      out[i] = out[i+1] = out[i+2] = v;
      out[i+3] = 255;
    }
    return new ImageData(out, imageData.width, imageData.height);
  }

  // ── Finder-pattern fallback for logos ────────────────────────────────────
  // Scans for the three 7-module finder squares by looking for the 1:1:3:1:1
  // dark/light run-length pattern in horizontal scan lines, clusters the hits,
  // then picks the three best clusters as TL / TR / BL corners.

  function findGridViaFinderPatterns(imageData) {
    const W = imageData.width, H = imageData.height;
    const px = imageData.data;

    function lum(x, y) {
      const i = (y * W + x) * 4;
      return 0.299 * px[i] + 0.587 * px[i+1] + 0.114 * px[i+2];
    }
    function isDark(x, y) { return lum(x, y) < 128; }

    // Collect centre-points of finder-pattern candidates from horizontal scans
    const centres = [];
    const step = Math.max(1, Math.floor(H / 200));

    for (let y = 0; y < H; y += step) {
      // Scan the row and collect run lengths
      const runs = [];
      let cur = isDark(0, y), count = 1;
      for (let x = 1; x < W; x++) {
        const d = isDark(x, y);
        if (d === cur) { count++; }
        else { runs.push({ dark: cur, len: count, x: x - count }); cur = d; count = 1; }
      }
      runs.push({ dark: cur, len: count, x: W - count });

      // Slide a window of 5 runs and look for 1:1:3:1:1 dark-light-dark-light-dark
      for (let i = 0; i + 4 < runs.length; i++) {
        const r = runs.slice(i, i + 5);
        if (!r[0].dark || r[1].dark || !r[2].dark || r[3].dark || !r[4].dark) continue;
        const unit = (r[0].len + r[1].len + r[2].len + r[3].len + r[4].len) / 7;
        if (unit < 2) continue;
        const tolerance = unit * 0.6;
        if (Math.abs(r[0].len - unit)     > tolerance) continue;
        if (Math.abs(r[1].len - unit)     > tolerance) continue;
        if (Math.abs(r[2].len - unit * 3) > tolerance * 3) continue;
        if (Math.abs(r[3].len - unit)     > tolerance) continue;
        if (Math.abs(r[4].len - unit)     > tolerance) continue;
        // Centre of the finder pattern
        const cx = r[2].x + Math.floor(r[2].len / 2);
        centres.push({ x: cx, y, unit });
      }
    }

    if (centres.length < 10) return null;

    // Cluster centres that are close together → one per finder pattern
    const clusters = [];
    for (const c of centres) {
      let merged = false;
      for (const cl of clusters) {
        if (Math.hypot(c.x - cl.x, c.y - cl.y) < cl.unit * 7) {
          cl.x = (cl.x * cl.n + c.x) / (cl.n + 1);
          cl.y = (cl.y * cl.n + c.y) / (cl.n + 1);
          cl.unit = (cl.unit * cl.n + c.unit) / (cl.n + 1);
          cl.n++;
          merged = true;
          break;
        }
      }
      if (!merged) clusters.push({ x: c.x, y: c.y, unit: c.unit, n: 1 });
    }

    // Keep the three clusters with the most votes
    clusters.sort((a, b) => b.n - a.n);
    const top = clusters.slice(0, 3);
    if (top.length < 3) return null;

    // Identify TL, TR, BL by relative position
    // TL is the one closest to the centroid of all three on both axes
    top.sort((a, b) => a.x + a.y - (b.x + b.y));
    const tl = top[0];
    const other = [top[1], top[2]];
    // TR is to the right of TL (larger x), BL is below (larger y)
    other.sort((a, b) => a.x - b.x);
    const bl = other[0].y > tl.y ? other[0] : other[1];
    const tr = other[0].y > tl.y ? other[1] : other[0];

    // Estimate module size and grid size
    const modW    = Math.hypot(tr.x - tl.x, tr.y - tl.y) / (tl.unit * 2 + /* finder */ 7);
    const modH    = Math.hypot(bl.x - tl.x, bl.y - tl.y) / (tl.unit * 2 + 7);
    const modSize = (modW + modH) / 2;

    // Snap to nearest valid QR version
    const estSize = Math.round(Math.hypot(tr.x - tl.x, tr.y - tl.y) / modSize);
    let gridSize = 21;
    let bestDiff = Infinity;
    for (let v = 1; v <= 40; v++) {
      const s = 4 * v + 17, d = Math.abs(s - estSize);
      if (d < bestDiff) { bestDiff = d; gridSize = s; }
    }

    // Derive all four corners from the three finder centres
    const loc = {
      topLeftCorner:     { x: tl.x - modSize * 3.5, y: tl.y - modSize * 3.5 },
      topRightCorner:    { x: tr.x + modSize * 3.5, y: tr.y - modSize * 3.5 },
      bottomLeftCorner:  { x: bl.x - modSize * 3.5, y: bl.y + modSize * 3.5 },
      bottomRightCorner: { x: tr.x + modSize * 3.5 + (bl.x - tl.x), y: bl.y + modSize * 3.5 + (tr.y - tl.y) },
    };

    const grid = unwarpAndSample(loc, gridSize);
    return { grid };
  }

  // ── Shared finish (meta, SVG, download) ──────────────────────────────────

  function finishPipeline(grid, version, decoded) {
    const svgStr   = buildSVG(grid);
    const gridSize = grid.length;

    hideSpinner();
    vecPh.style.display      = 'none';
    svgPreview.innerHTML     = svgStr;
    svgPreview.style.display = 'flex';

    const darkCount = grid.flat().filter(Boolean).length;
    document.getElementById('meta-size').textContent    = `${gridSize}×${gridSize}`;
    document.getElementById('meta-modules').textContent = darkCount;
    document.getElementById('meta-version').textContent = version >= 1 ? `v${version}` : '—';

    const metaDecode = document.getElementById('meta-decode');
    if (decoded) {
      const isUrl = /^https?:\/\//i.test(decoded);
      metaDecode.innerHTML = isUrl
        ? `<a href="${encodeURI(decoded)}" target="_blank" rel="noopener">${decoded}</a>`
        : `"${decoded}"`;
    } else {
      metaDecode.textContent = '(logo QR — data not decoded)';
    }

    metaBar.style.display = 'flex';
    actions.style.display = 'flex';

    const blob = new Blob([svgStr], { type: 'image/svg+xml' });
    downloadBtn.href = URL.createObjectURL(blob);
  }

  // ── Perspective unwarp + grid sampling ───────────────────────────────────

  function unwarpAndSample(loc, size) {
    const tl = loc.topLeftCorner;
    const tr = loc.topRightCorner;
    const bl = loc.bottomLeftCorner;
    const br = loc.bottomRightCorner;

    const modW  = Math.hypot(tr.x - tl.x, tr.y - tl.y) / size;
    const modH  = Math.hypot(bl.x - tl.x, bl.y - tl.y) / size;
    const patch = Math.max(1, Math.floor(Math.min(modW, modH) * 0.3));

    const grid = [];
    for (let row = 0; row < size; row++) {
      const rowArr = [];
      for (let col = 0; col < size; col++) {
        const u = (col + 0.5) / size;
        const v = (row + 0.5) / size;
        const px = (1-v)*(1-u)*tl.x + (1-v)*u*tr.x + v*(1-u)*bl.x + v*u*br.x;
        const py = (1-v)*(1-u)*tl.y + (1-v)*u*tr.y + v*(1-u)*bl.y + v*u*br.y;
        rowArr.push(patchLuminance(px, py, patch) < 128 ? 1 : 0);
      }
      grid.push(rowArr);
    }
    return grid;
  }

  function patchLuminance(cx, cy, r) {
    const x0 = clamp(Math.round(cx - r), 0, canvas.width  - 1);
    const y0 = clamp(Math.round(cy - r), 0, canvas.height - 1);
    const x1 = clamp(Math.round(cx + r), 0, canvas.width  - 1);
    const y1 = clamp(Math.round(cy + r), 0, canvas.height - 1);
    const w  = x1 - x0 + 1;
    const h  = y1 - y0 + 1;
    if (w <= 0 || h <= 0) return 255;
    const data = ctx.getImageData(x0, y0, w, h).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4)
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return sum / (w * h);
  }

  // ── SVG builder ──────────────────────────────────────────────────────────

  function buildSVG(grid) {
    const size  = grid.length;
    const quiet = 4;
    const total = size + quiet * 2;
    let rects = '';

    for (let r = 0; r < size; r++) {
      let start = null;
      for (let c = 0; c <= size; c++) {
        const dark = c < size && grid[r][c];
        if (dark && start === null) {
          start = c;
        } else if (!dark && start !== null) {
          rects += `<rect x="${quiet + start}" y="${quiet + r}" width="${c - start}" height="1"/>`;
          start = null;
        }
      }
    }

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
      `<rect width="${total}" height="${total}" fill="white"/>` +
      `<g fill="black">${rects}</g>` +
      `</svg>`
    );
  }

  // ── UI helpers ───────────────────────────────────────────────────────────

  function showImagePreview(src) {
    origPh.style.display  = 'none';
    previewImg.src        = src;
    previewImg.style.display = 'block';
    errorBox.style.display   = 'none';
  }

  function showSpinner() { spinner.style.display = 'block'; }
  function hideSpinner() { spinner.style.display = 'none'; }

  function showError(msg) {
    errorBox.textContent   = '⚠  ' + msg;
    errorBox.style.display = 'block';
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function reset(clearUrl = true) {
    previewImg.style.display = 'none';
    previewImg.src           = '';
    origPh.style.display     = '';
    svgPreview.style.display = 'none';
    svgPreview.innerHTML     = '';
    vecPh.style.display      = '';
    errorBox.style.display   = 'none';
    metaBar.style.display    = 'none';
    actions.style.display    = 'none';
    spinner.style.display    = 'none';
    fileInput.value          = '';
    if (clearUrl) urlInput.value = '';
  }

})();
