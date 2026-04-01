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
  const ctx         = canvas.getContext('2d', { willReadFrequently: true });

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
  resetBtn.addEventListener('click', reset);

  // ── Core flow ────────────────────────────────────────────────────────────

  function processFile(file) {
    reset();
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        origPh.style.display = 'none';
        previewImg.src = e.target.result;
        previewImg.style.display = 'block';
        spinner.style.display = 'block';
        setTimeout(() => runPipeline(img), 60);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function runPipeline(img) {
    try {
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // Try normal then inverted
      const code =
        jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' }) ||
        jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: 'onlyInvert' });

      if (!code) {
        spinner.style.display = 'none';
        showError('No QR code detected. Make sure the full code is visible with good contrast and minimal blur.');
        return;
      }

      // jsQR gives us code.version (1–40) directly — no guessing needed.
      // Grid size is always exactly 4*version + 17.
      const version  = code.version;
      const gridSize = 4 * version + 17;

      // Unwarp the QR region and sample one value per module centre.
      const grid = unwarpAndSample(code.location, gridSize);

      const svgStr = buildSVG(grid);

      spinner.style.display    = 'none';
      vecPh.style.display      = 'none';
      svgPreview.innerHTML     = svgStr;
      svgPreview.style.display = 'flex';

      // Meta bar
      const darkCount = grid.flat().filter(Boolean).length;
      document.getElementById('meta-size').textContent    = `${gridSize}×${gridSize}`;
      document.getElementById('meta-modules').textContent = darkCount;
      document.getElementById('meta-version').textContent = `v${version}`;
      document.getElementById('meta-decode').textContent  =
        code.data ? `"${code.data.length > 72 ? code.data.slice(0, 72) + '…' : code.data}"` : '';

      metaBar.style.display = 'flex';
      actions.style.display = 'flex';

      const blob = new Blob([svgStr], { type: 'image/svg+xml' });
      downloadBtn.href = URL.createObjectURL(blob);

    } catch (err) {
      spinner.style.display = 'none';
      showError('Error: ' + err.message);
      console.error(err);
    }
  }

  // ── Perspective unwarp + grid sampling ───────────────────────────────────
  //
  // jsQR gives us the four corner pixel coords of the QR in the source image.
  // We bilinearly interpolate to find each module's centre pixel, then average
  // a small patch of pixels around it (more robust than a single pixel read).

  function unwarpAndSample(loc, size) {
    const tl = loc.topLeftCorner;
    const tr = loc.topRightCorner;
    const bl = loc.bottomLeftCorner;
    const br = loc.bottomRightCorner;

    // Patch radius: ~30% of one module's pixel size, minimum 1px
    const modW  = Math.hypot(tr.x - tl.x, tr.y - tl.y) / size;
    const modH  = Math.hypot(bl.x - tl.x, bl.y - tl.y) / size;
    const patch = Math.max(1, Math.floor(Math.min(modW, modH) * 0.3));

    const grid = [];
    for (let row = 0; row < size; row++) {
      const rowArr = [];
      for (let col = 0; col < size; col++) {
        // Normalised (u, v) = centre of this module
        const u = (col + 0.5) / size;
        const v = (row + 0.5) / size;

        // Bilinear map → pixel coords in the original image
        const px = (1-v)*(1-u)*tl.x + (1-v)*u*tr.x + v*(1-u)*bl.x + v*u*br.x;
        const py = (1-v)*(1-u)*tl.y + (1-v)*u*tr.y + v*(1-u)*bl.y + v*u*br.y;

        rowArr.push(patchLuminance(px, py, patch) < 128 ? 1 : 0);
      }
      grid.push(rowArr);
    }
    return grid;
  }

  // Average luminance of a (2r+1)² patch centred on (cx, cy)
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
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return sum / (w * h);
  }

  // ── SVG builder ──────────────────────────────────────────────────────────

  function buildSVG(grid) {
    const size  = grid.length;
    const quiet = 4;           // standard 4-module quiet zone
    const total = size + quiet * 2;
    let rects = '';

    // Merge consecutive dark modules per row → compact SVG output
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

  // ── Helpers ──────────────────────────────────────────────────────────────

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function showError(msg) {
    errorBox.textContent = '⚠  ' + msg;
    errorBox.style.display = 'block';
  }

  function reset() {
    previewImg.style.display = 'none';
    previewImg.src = '';
    origPh.style.display = '';
    svgPreview.style.display = 'none';
    svgPreview.innerHTML = '';
    vecPh.style.display = '';
    errorBox.style.display = 'none';
    metaBar.style.display = 'none';
    actions.style.display = 'none';
    spinner.style.display = 'none';
    fileInput.value = '';
  }

})();
