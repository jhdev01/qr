(() => {
  const dropZone   = document.getElementById('drop-zone');
  const fileInput  = document.getElementById('file-input');
  const previewImg = document.getElementById('preview-img');
  const origPh     = document.getElementById('orig-ph');
  const svgPreview = document.getElementById('svg-preview');
  const vecPh      = document.getElementById('vec-ph');
  const errorBox   = document.getElementById('error-box');
  const metaBar    = document.getElementById('meta-bar');
  const actions    = document.getElementById('actions');
  const downloadBtn= document.getElementById('download-btn');
  const resetBtn   = document.getElementById('reset-btn');
  const canvas     = document.getElementById('canvas');
  const spinner    = document.getElementById('spinner');
  const ctx        = canvas.getContext('2d');

  // ── Event wiring ──────────────────────────────────────────────────────────

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => e.target.files[0] && processFile(e.target.files[0]));

  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) processFile(f);
  });

  resetBtn.addEventListener('click', reset);

  // ── Core flow ─────────────────────────────────────────────────────────────

  function processFile(file) {
    reset();
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        // Show original preview
        origPh.style.display = 'none';
        previewImg.src = e.target.result;
        previewImg.style.display = 'block';
        spinner.style.display = 'block';
        errorBox.style.display = 'none';

        // Defer so the browser paints the preview first
        setTimeout(() => runPipeline(img), 60);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function runPipeline(img) {
    try {
      // 1. Draw to canvas and grab pixel data
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // 2. Try jsQR with both inversion modes
      const code =
        jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' }) ||
        jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: 'onlyInvert' });

      if (!code) {
        spinner.style.display = 'none';
        showError('No QR code detected. Tips: ensure good contrast, minimal blur, and that the full code is visible.');
        return;
      }

      // 3. Sample the module grid using detected corner points
      const gridSize = estimateGridSize(code);
      const grid     = sampleGrid(code.location, gridSize);

      // 4. Build SVG
      const svgStr = buildSVG(grid);

      // 5. Render
      spinner.style.display = 'none';
      vecPh.style.display = 'none';
      svgPreview.innerHTML = svgStr;
      svgPreview.style.display = 'flex';

      // 6. Meta
      const darkCount = grid.flat().filter(Boolean).length;
      const version   = Math.round((gridSize - 17) / 4);
      document.getElementById('meta-size').textContent    = `${gridSize}×${gridSize}`;
      document.getElementById('meta-modules').textContent = darkCount;
      document.getElementById('meta-version').textContent = version >= 1 ? `v${version}` : '—';
      document.getElementById('meta-decode').textContent  =
        code.data ? `"${code.data.length > 70 ? code.data.slice(0, 70) + '…' : code.data}"` : '';

      metaBar.style.display  = 'flex';
      actions.style.display  = 'flex';

      // 7. Download link
      const blob = new Blob([svgStr], { type: 'image/svg+xml' });
      downloadBtn.href = URL.createObjectURL(blob);

    } catch (err) {
      spinner.style.display = 'none';
      showError('Error: ' + err.message);
    }
  }

  // ── Grid size estimation ──────────────────────────────────────────────────

  function estimateGridSize(code) {
    const loc = code.location;

    // Count pixel transitions along the top edge → ≈ number of modules
    const samples = 300;
    let transitions = 0;
    let lastDark = null;

    for (let i = 0; i < samples; i++) {
      const t  = i / (samples - 1);
      const px = Math.round(lerp(loc.topLeftCorner.x, loc.topRightCorner.x, t));
      const py = Math.round(lerp(loc.topLeftCorner.y, loc.topRightCorner.y, t));
      const cx = clamp(px, 0, canvas.width  - 1);
      const cy = clamp(py, 0, canvas.height - 1);
      const d  = ctx.getImageData(cx, cy, 1, 1).data;
      const lum = 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2];
      const dark = lum < 128;
      if (lastDark !== null && dark !== lastDark) transitions++;
      lastDark = dark;
    }

    // Snap to nearest valid QR grid size (4v+17, v=1..40)
    const est = Math.round(transitions);
    let best = 21, bestDiff = Infinity;
    for (let v = 1; v <= 40; v++) {
      const s    = 4 * v + 17;
      const diff = Math.abs(s - est);
      if (diff < bestDiff) { bestDiff = diff; best = s; }
    }
    return best;
  }

  // ── Perspective-corrected grid sampling ──────────────────────────────────

  function sampleGrid(loc, size) {
    const { topLeftCorner: tl, topRightCorner: tr, bottomLeftCorner: bl, bottomRightCorner: br } = loc;
    const grid = [];

    for (let row = 0; row < size; row++) {
      grid.push([]);
      for (let col = 0; col < size; col++) {
        const t = (row + 0.5) / size;
        const s = (col + 0.5) / size;

        // Bilinear interpolation across the four detected corners
        const x = (1-t)*(1-s)*tl.x + (1-t)*s*tr.x + t*(1-s)*bl.x + t*s*br.x;
        const y = (1-t)*(1-s)*tl.y + (1-t)*s*tr.y + t*(1-s)*bl.y + t*s*br.y;

        const px  = clamp(Math.round(x), 0, canvas.width  - 1);
        const py  = clamp(Math.round(y), 0, canvas.height - 1);
        const d   = ctx.getImageData(px, py, 1, 1).data;
        const lum = 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2];
        grid[row].push(lum < 128 ? 1 : 0);
      }
    }
    return grid;
  }

  // ── SVG builder ───────────────────────────────────────────────────────────

  function buildSVG(grid) {
    const size  = grid.length;
    const quiet = 4;               // standard quiet zone (4 modules)
    const total = size + quiet * 2;
    let rects = '';

    // Merge consecutive dark cells in each row → fewer <rect> elements
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

    return [
      `<svg xmlns="http://www.w3.org/2000/svg"`,
      ` viewBox="0 0 ${total} ${total}"`,
      ` shape-rendering="crispEdges">`,
      `<rect width="${total}" height="${total}" fill="white"/>`,
      `<g fill="black">${rects}</g>`,
      `</svg>`
    ].join('');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function lerp(a, b, t) { return a + (b - a) * t; }
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
