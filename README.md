# QR Vectorizer

Upload a raster QR code image (PNG, JPG, WEBP, etc.) and download a perfect, geometry-accurate SVG — with exact squares reconstructed from the decoded module grid.

**100% client-side.** No server, no uploads, no data leaves the browser.

---

## How it works

1. **jsQR** decodes the QR code and detects the four corner points
2. **Perspective correction** via bilinear interpolation samples each module cell accurately, even with slight skew or rotation
3. **Grid size detection** counts pixel transitions along the top edge and snaps to the nearest valid QR version (v1–v40)
4. **SVG generation** merges consecutive dark modules into horizontal `<rect>` runs — clean, minimal, `crispEdges`-rendered

---

## Deploy to Vercel (recommended)

```bash
# 1. Clone or download this repo
git clone https://github.com/YOUR_USERNAME/qr-vectorizer.git
cd qr-vectorizer

# 2. Install Vercel CLI (if you haven't)
npm i -g vercel

# 3. Deploy
vercel
```

Vercel auto-detects static sites. No config needed.

Or just drag-and-drop the project folder at **vercel.com/new**.

---

## Deploy to GitHub Pages

```bash
# 1. Push to a GitHub repo
git init
git add .
git commit -m "init"
git remote add origin https://github.com/YOUR_USERNAME/qr-vectorizer.git
git push -u origin main

# 2. Go to Settings → Pages → Source: Deploy from branch → main / root
```

Your site will be live at `https://YOUR_USERNAME.github.io/qr-vectorizer`

---

## Local development

Just open `index.html` in a browser — no build step, no dependencies to install.

```bash
# Optional: serve with any static server
npx serve .
# or
python3 -m http.server 3000
```

---

## Files

```
qr-vectorizer/
├── index.html   # UI, styles
└── app.js       # QR decode + SVG generation logic
```

---

## Tips for best results

- Use images with **good contrast** (dark modules on white background)
- The full QR code should be visible — avoid cropping
- Works with slightly skewed or perspective-distorted photos
- Blurry or very low-resolution images may fail to decode
