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

  // ── Tab switching ──────────────────────────────────────────────────────────

  window.switchTab = function(tab) {
    document.getElementById('panel-upload').style.display = tab === 'upload' ? 'block' : 'none';
    document.getElementById('panel-url').classList.toggle('visible', tab === 'url');
    document.getElementById('tab-upload').classList.toggle('active', tab === 'upload');
    document.getElementById('tab-url').classList.toggle('active', tab === 'url');
  };

  // ── Event wiring ──────────────────────────────────────────────────────────

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

  // ── Generate QR from URL/text ──────────────────────────────────────────────

  function generateFromUrl() {
    let text = urlInput.value.trim();
    if (!text) return;
    if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(text) && !/^https?:\/\//i.test(text)) {
      text = 'https://' + text;
      urlInput.value = text;
    }
    reset(false);
    showSpinner();
    try {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      const moduleCount = qr.getModuleCount();
      const version = (moduleCount - 17) / 4;
      const grid = [];
      for (let r = 0; r < moduleCount; r++) {
        const row = [];
        for (let c = 0; c < moduleCount; c++) row.push(qr.isDark(r, c) ? 1 : 0);
        grid.push(row);
      }
      // Draw raster preview
      const scale = 8, quiet = 4, total = moduleCount + quiet * 2;
      canvas.width = total * scale; canvas.height = total * scale;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000000';
      for (let r = 0; r < moduleCount; r++)
        for (let c = 0; c < moduleCount; c++)
          if (grid[r][c]) ctx.fillRect((quiet+c)*scale, (quiet+r)*scale, scale, scale);
      origPh.style.display = 'none';
      previewImg.src = canvas.toDataURL();
      previewImg.style.display = 'block';
      finishPipeline(grid, version, text);
    } catch (err) {
      hideSpinner();
      showError('Error generating QR code: ' + err.message);
    }
  }

  // ── File processing ────────────────────────────────────────────────────────

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

  // ── Pipeline ──────────────────────────────────────────────────────────────

  function runPipeline(img) {
    try {
      // Draw onto white background (handles transparency)
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      // Try jsQR at multiple contrast thresholds
      const code = tryJsQR();

      if (code && code.location && code.location.topLeftCorner) {
        const version  = code.version;
        const gridSize = 4 * version + 17;
        const grid     = unwarpAndSample(code.location, gridSize);
        finishPipeline(grid, version, code.data || '');
      } else {
        // Fallback: find grid geometrically via finder patterns
        const result = findViaFinderPatterns();
        if (result) {
          const version = (result.grid.length - 17) / 4;
          finishPipeline(result.grid, version, '');
        } else {
          hideSpinner();
          showError('Could not detect the QR code. Try a higher resolution image, or ensure the QR has strong contrast between modules and background.');
        }
      }
    } catch (err) {
      hideSpinner();
      showError('Error: ' + err.message);
      console.error(err);
    }
  }

  // Try jsQR across several binarization thresholds
  function tryJsQR() {
    const W = canvas.width, H = canvas.height;
    const raw = ctx.getImageData(0, 0, W, H);

    // Attempt 1: raw image, both inversions
    let code = jsQR(raw.data, W, H, { inversionAttempts: 'dontInvert' })
            || jsQR(raw.data, W, H, { inversionAttempts: 'onlyInvert' });
    if (code && code.location) return code;

    // Attempts 2–5: binarize at different thresholds (helps grey-on-white QRs)
    for (const threshold of [160, 100, 200, 80]) {
      const bin = binarize(raw, threshold);
      code = jsQR(bin, W, H, { inversionAttempts: 'dontInvert' })
          || jsQR(bin, W, H, { inversionAttempts: 'onlyInvert' });
      if (code && code.location) return code;
    }

    // Attempt 6: auto-threshold using Otsu's method
    const otsuBin = binarize(raw, otsuThreshold(raw));
    code = jsQR(otsuBin, W, H, { inversionAttempts: 'dontInvert' })
        || jsQR(otsuBin, W, H, { inversionAttempts: 'onlyInvert' });
    if (code && code.location) return code;

    return null;
  }

  // Binarize imageData to pure black/white at a given luminance threshold
  function binarize(imageData, threshold) {
    const src = imageData.data;
    const out = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i += 4) {
      const lum = 0.299*src[i] + 0.587*src[i+1] + 0.114*src[i+2];
      const v   = lum < threshold ? 0 : 255;
      out[i] = out[i+1] = out[i+2] = v; out[i+3] = 255;
    }
    return out;
  }

  // Otsu's method: find optimal threshold by maximising inter-class variance
  function otsuThreshold(imageData) {
    const src  = imageData.data;
    const hist = new Array(256).fill(0);
    const N    = src.length / 4;
    for (let i = 0; i < src.length; i += 4) {
      const lum = Math.round(0.299*src[i] + 0.587*src[i+1] + 0.114*src[i+2]);
      hist[lum]++;
    }
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, max = 0, thresh = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = N - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) ** 2;
      if (between > max) { max = between; thresh = t; }
    }
    return thresh;
  }

  // ── Finder-pattern geometric fallback ─────────────────────────────────────
  // Scans rows for the 1:1:3:1:1 dark/light run pattern that identifies QR
  // finder squares, clusters hits into three corners, then derives the grid.

  function findViaFinderPatterns() {
    const W = canvas.width, H = canvas.height;

    // Work on Otsu-binarized pixel data for clean run detection
    const raw    = ctx.getImageData(0, 0, W, H);
    const thresh = otsuThreshold(raw);
    const bin    = binarize(raw, thresh);

    function isDark(x, y) {
      const i = (y * W + x) * 4;
      return bin[i] < 128;
    }

    const centres = [];
    const step = Math.max(1, Math.floor(H / 300));

    for (let y = step; y < H - step; y += step) {
      // Build run-length array for this row
      const runs = [];
      let cur = isDark(0, y), count = 1;
      for (let x = 1; x < W; x++) {
        const d = isDark(x, y);
        if (d === cur) { count++; }
        else { runs.push([cur, count, x - count]); cur = d; count = 1; }
      }
      runs.push([cur, count, W - count]);

      // Slide 5-run window looking for dark:light:dark:light:dark in 1:1:3:1:1
      for (let i = 0; i + 4 < runs.length; i++) {
        const [d0,,] = runs[i],   [d1,,] = runs[i+1], [d2,,] = runs[i+2],
              [d3,,] = runs[i+3], [d4,,] = runs[i+4];
        if (!d0 || d1 || !d2 || d3 || !d4) continue;
        const l0 = runs[i][1], l1 = runs[i+1][1], l2 = runs[i+2][1],
              l3 = runs[i+3][1], l4 = runs[i+4][1];
        const unit = (l0+l1+l2+l3+l4) / 7;
        if (unit < 1.5) continue;
        const tol = unit * 0.7;
        if (Math.abs(l0-unit)   > tol) continue;
        if (Math.abs(l1-unit)   > tol) continue;
        if (Math.abs(l2-unit*3) > tol*3) continue;
        if (Math.abs(l3-unit)   > tol) continue;
        if (Math.abs(l4-unit)   > tol) continue;
        const cx = runs[i+2][2] + Math.floor(l2/2);
        centres.push({ x: cx, y, unit });
      }
    }

    if (centres.length < 5) return null;

    // Cluster nearby hits → one cluster per finder pattern
    const clusters = [];
    for (const c of centres) {
      let best = null, bestD = Infinity;
      for (const cl of clusters) {
        const d = Math.hypot(c.x - cl.x, c.y - cl.y);
        if (d < cl.unit * 8 && d < bestD) { bestD = d; best = cl; }
      }
      if (best) {
        best.x = (best.x * best.n + c.x) / (best.n + 1);
        best.y = (best.y * best.n + c.y) / (best.n + 1);
        best.unit = (best.unit * best.n + c.unit) / (best.n + 1);
        best.n++;
      } else {
        clusters.push({ x: c.x, y: c.y, unit: c.unit, n: 1 });
      }
    }

    clusters.sort((a, b) => b.n - a.n);
    if (clusters.length < 3) return null;
    const top3 = clusters.slice(0, 3);

    // Assign TL, TR, BL by position
    // Sort by x+y: smallest = top-left
    top3.sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const tl = top3[0];
    const rem = [top3[1], top3[2]];
    // Of the remaining two, higher y = bottom-left, lower y = top-right
    rem.sort((a, b) => a.y - b.y);
    const tr = rem[0], bl = rem[1];

    // Unit size = average from all three clusters
    const unit = (tl.unit + tr.unit + bl.unit) / 3;

    // Each finder is 7 modules wide/tall; its centre is at module 3.5 from the QR edge
    // So: top-left of QR = tl.centre - 3.5 * modSize
    // Distance TL→TR spans from col 3.5 to col (size-3.5) = size-7 modules
    const tltrDist = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const tlblDist = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    const modSizeH = tltrDist / (/* size-7 estimated via unit */ tltrDist / unit);
    // Simpler: just use unit directly as module size
    const modSize  = unit;

    // Estimate grid size from pixel span + snap to valid QR size
    const spanModules = Math.round(tltrDist / modSize);
    let gridSize = 21, bestDiff = Infinity;
    for (let v = 1; v <= 40; v++) {
      const s = 4*v+17, d = Math.abs(s - (spanModules + 7));
      if (d < bestDiff) { bestDiff = d; gridSize = s; }
    }

    // Four corners of the QR code (outer edge of quiet zone excluded,
    // outer edge of finder pattern included)
    const loc = {
      topLeftCorner:     { x: tl.x - modSize*3.5, y: tl.y - modSize*3.5 },
      topRightCorner:    { x: tr.x + modSize*3.5, y: tr.y - modSize*3.5 },
      bottomLeftCorner:  { x: bl.x - modSize*3.5, y: bl.y + modSize*3.5 },
      bottomRightCorner: {
        x: tr.x + modSize*3.5 + (bl.x - tl.x),
        y: bl.y + modSize*3.5 + (tr.y - tl.y)
      },
    };

    const grid = unwarpAndSample(loc, gridSize);
    return { grid };
  }

  // ── Perspective unwarp + per-module sampling ───────────────────────────────

  function unwarpAndSample(loc, size) {
    const tl = loc.topLeftCorner,  tr = loc.topRightCorner;
    const bl = loc.bottomLeftCorner, br = loc.bottomRightCorner;

    const modW  = Math.hypot(tr.x-tl.x, tr.y-tl.y) / size;
    const modH  = Math.hypot(bl.x-tl.x, bl.y-tl.y) / size;
    const patch = Math.max(1, Math.floor(Math.min(modW, modH) * 0.35));

    // Compute adaptive threshold per-image using Otsu on the raw canvas
    const raw    = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const thresh = otsuThreshold(raw);

    const grid = [];
    for (let row = 0; row < size; row++) {
      const rowArr = [];
      for (let col = 0; col < size; col++) {
        const u  = (col + 0.5) / size;
        const v  = (row + 0.5) / size;
        const px = (1-v)*(1-u)*tl.x + (1-v)*u*tr.x + v*(1-u)*bl.x + v*u*br.x;
        const py = (1-v)*(1-u)*tl.y + (1-v)*u*tr.y + v*(1-u)*bl.y + v*u*br.y;
        rowArr.push(patchLuminance(px, py, patch) < thresh ? 1 : 0);
      }
      grid.push(rowArr);
    }
    return grid;
  }

  function patchLuminance(cx, cy, r) {
    const x0 = clamp(Math.round(cx-r), 0, canvas.width-1);
    const y0 = clamp(Math.round(cy-r), 0, canvas.height-1);
    const x1 = clamp(Math.round(cx+r), 0, canvas.width-1);
    const y1 = clamp(Math.round(cy+r), 0, canvas.height-1);
    const w = x1-x0+1, h = y1-y0+1;
    if (w <= 0 || h <= 0) return 255;
    const data = ctx.getImageData(x0, y0, w, h).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4)
      sum += 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
    return sum / (w * h);
  }

  // ── SVG builder ────────────────────────────────────────────────────────────

  function buildSVG(grid) {
    const size = grid.length, quiet = 4, total = size + quiet*2;
    let rects = '';
    for (let r = 0; r < size; r++) {
      let start = null;
      for (let c = 0; c <= size; c++) {
        const dark = c < size && grid[r][c];
        if (dark && start === null) { start = c; }
        else if (!dark && start !== null) {
          rects += `<rect x="${quiet+start}" y="${quiet+r}" width="${c-start}" height="1"/>`;
          start = null;
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
           `<rect width="${total}" height="${total}" fill="white"/>` +
           `<g fill="black">${rects}</g></svg>`;
  }

  // ── Shared finish ──────────────────────────────────────────────────────────

  function finishPipeline(grid, version, decoded) {
    const svgStr = buildSVG(grid);
    hideSpinner();
    vecPh.style.display      = 'none';
    svgPreview.innerHTML     = svgStr;
    svgPreview.style.display = 'flex';

    const darkCount = grid.flat().filter(Boolean).length;
    document.getElementById('meta-size').textContent    = `${grid.length}×${grid.length}`;
    document.getElementById('meta-modules').textContent = darkCount;
    document.getElementById('meta-version').textContent = version >= 1 ? `v${version}` : '—';

    const metaDecode = document.getElementById('meta-decode');
    if (decoded) {
      const isUrl = /^https?:\/\//i.test(decoded);
      metaDecode.innerHTML = isUrl
        ? `<a href="${encodeURI(decoded)}" target="_blank" rel="noopener">${decoded}</a>`
        : `"${decoded}"`;
    } else {
      metaDecode.textContent = '(logo QR — content not decoded)';
    }

    metaBar.style.display = 'flex';
    actions.style.display = 'flex';
    const blob = new Blob([svgStr], { type: 'image/svg+xml' });
    downloadBtn.href = URL.createObjectURL(blob);
  }

  // ── UI helpers ────────────────────────────────────────────────────────────

  function showImagePreview(src) {
    origPh.style.display     = 'none';
    previewImg.src           = src;
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
    previewImg.style.display = 'none'; previewImg.src = '';
    origPh.style.display     = '';
    svgPreview.style.display = 'none'; svgPreview.innerHTML = '';
    vecPh.style.display      = '';
    errorBox.style.display   = 'none';
    metaBar.style.display    = 'none';
    actions.style.display    = 'none';
    spinner.style.display    = 'none';
    fileInput.value          = '';
    if (clearUrl) urlInput.value = '';
  }

})();
