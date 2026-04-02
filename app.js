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

      // Build SVG directly from the grid — perfect accuracy, no re-sampling
      const svgStr = buildSVG(grid);

      hideSpinner();
      vecPh.style.display      = 'none';
      svgPreview.innerHTML     = svgStr;
      svgPreview.style.display = 'flex';

      // Meta
      const darkCount = grid.flat().filter(Boolean).length;
      const version   = (moduleCount - 17) / 4;
      document.getElementById('meta-size').textContent    = `${moduleCount}×${moduleCount}`;
      document.getElementById('meta-modules').textContent = darkCount;
      document.getElementById('meta-version').textContent = `v${version}`;

      const metaDecode = document.getElementById('meta-decode');
      const isUrl = /^https?:\/\//i.test(text);
      metaDecode.innerHTML = isUrl
        ? `<a href="${encodeURI(text)}" target="_blank" rel="noopener">${text}</a>`
        : `"${text}"`;

      metaBar.style.display = 'flex';
      actions.style.display = 'flex';

      const blob = new Blob([svgStr], { type: 'image/svg+xml' });
      downloadBtn.href = URL.createObjectURL(blob);

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
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      const code =
        jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' }) ||
        jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: 'onlyInvert' });

      if (!code) {
        hideSpinner();
        showError('No QR code detected. Make sure the full code is visible with good contrast and minimal blur.');
        return;
      }

      // jsQR gives us the version directly — grid size = 4*version + 17
      const version  = code.version;
      const gridSize = 4 * version + 17;
      const grid     = unwarpAndSample(code.location, gridSize);
      const svgStr   = buildSVG(grid);

      // ── Show SVG preview ────────────────────────────────────────────────
      hideSpinner();
      vecPh.style.display      = 'none';
      svgPreview.innerHTML     = svgStr;
      svgPreview.style.display = 'flex';

      // ── Meta ────────────────────────────────────────────────────────────
      const darkCount = grid.flat().filter(Boolean).length;
      document.getElementById('meta-size').textContent    = `${gridSize}×${gridSize}`;
      document.getElementById('meta-modules').textContent = darkCount;
      document.getElementById('meta-version').textContent = `v${version}`;
      const metaDecode = document.getElementById('meta-decode');
      if (code.data) {
        const isUrl = /^https?:\/\//i.test(code.data);
        if (isUrl) {
          metaDecode.innerHTML = `<a href="${encodeURI(code.data)}" target="_blank" rel="noopener">${code.data}</a>`;
        } else {
          metaDecode.textContent = `"${code.data}"`;
        }
      } else {
        metaDecode.textContent = '';
      }

      metaBar.style.display = 'flex';
      actions.style.display = 'flex';

      const blob = new Blob([svgStr], { type: 'image/svg+xml' });
      downloadBtn.href = URL.createObjectURL(blob);

    } catch (err) {
      hideSpinner();
      showError('Error: ' + err.message);
      console.error(err);
    }
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
