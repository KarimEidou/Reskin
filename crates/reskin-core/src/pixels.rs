//! Small RGBA image type plus the pixel fix-ups the extraction ladder needs
//! (premultiplied-alpha detection, alpha-bbox normalisation) and PNG /
//! base64 helpers.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

/// Straight-alpha RGBA8 image, rows top to bottom.
#[derive(Clone, PartialEq, Eq)]
pub struct Rgba {
    pub w: u32,
    pub h: u32,
    pub data: Vec<u8>,
}

impl std::fmt::Debug for Rgba {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Rgba({}x{})", self.w, self.h)
    }
}

/// Inclusive-exclusive pixel box `[x0, x1) × [y0, y1)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelBox {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
}

impl PixelBox {
    pub fn width(&self) -> u32 {
        self.x1 - self.x0
    }
    pub fn height(&self) -> u32 {
        self.y1 - self.y0
    }
}

impl Rgba {
    pub fn new(w: u32, h: u32) -> Self {
        Self {
            w,
            h,
            data: vec![0; (w as usize) * (h as usize) * 4],
        }
    }

    pub fn from_raw(w: u32, h: u32, data: Vec<u8>) -> Result<Self, String> {
        if data.len() != (w as usize) * (h as usize) * 4 {
            return Err(format!(
                "pixel buffer is {} bytes, expected {} for {w}x{h}",
                data.len(),
                (w as usize) * (h as usize) * 4
            ));
        }
        Ok(Self { w, h, data })
    }

    /// A solid-colour image (handy in tests).
    pub fn filled(w: u32, h: u32, px: [u8; 4]) -> Self {
        let mut img = Self::new(w, h);
        for c in img.data.chunks_exact_mut(4) {
            c.copy_from_slice(&px);
        }
        img
    }

    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * self.w + x) * 4) as usize;
        [
            self.data[i],
            self.data[i + 1],
            self.data[i + 2],
            self.data[i + 3],
        ]
    }

    pub fn set_pixel(&mut self, x: u32, y: u32, px: [u8; 4]) {
        let i = ((y * self.w + x) * 4) as usize;
        self.data[i..i + 4].copy_from_slice(&px);
    }

    /// Every pixel is fully transparent.
    pub fn is_blank(&self) -> bool {
        self.data.chunks_exact(4).all(|p| p[3] == 0)
    }

    /// Bounding box of pixels with alpha > `threshold`, or `None` if blank.
    pub fn alpha_bbox(&self, threshold: u8) -> Option<PixelBox> {
        let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
        for y in 0..self.h {
            let row = &self.data[(y * self.w * 4) as usize..((y + 1) * self.w * 4) as usize];
            for x in 0..self.w {
                if row[(x * 4 + 3) as usize] > threshold {
                    x0 = x0.min(x);
                    y0 = y0.min(y);
                    x1 = x1.max(x + 1);
                    y1 = y1.max(y + 1);
                }
            }
        }
        (x0 != u32::MAX).then_some(PixelBox { x0, y0, x1, y1 })
    }

    pub fn crop(&self, b: PixelBox) -> Rgba {
        let mut out = Rgba::new(b.width(), b.height());
        for y in 0..b.height() {
            let src = (((b.y0 + y) * self.w + b.x0) * 4) as usize;
            let dst = (y * b.width() * 4) as usize;
            let n = (b.width() * 4) as usize;
            out.data[dst..dst + n].copy_from_slice(&self.data[src..src + n]);
        }
        out
    }

    /// Area-average downscale (or nearest upscale) to `w`×`h`, done in
    /// premultiplied space so transparent edges don't darken.
    pub fn resize(&self, w: u32, h: u32) -> Rgba {
        if w == self.w && h == self.h {
            return self.clone();
        }
        let mut out = Rgba::new(w, h);
        let sx = self.w as f64 / w as f64;
        let sy = self.h as f64 / h as f64;
        for oy in 0..h {
            let fy0 = oy as f64 * sy;
            let fy1 = ((oy + 1) as f64 * sy).max(fy0 + 1e-9);
            for ox in 0..w {
                let fx0 = ox as f64 * sx;
                let fx1 = ((ox + 1) as f64 * sx).max(fx0 + 1e-9);
                let mut acc = [0f64; 4];
                let mut area = 0f64;
                let mut y = fy0.floor() as u32;
                while (y as f64) < fy1 && y < self.h {
                    let wy = (fy1.min(y as f64 + 1.0) - fy0.max(y as f64)).max(0.0);
                    let mut x = fx0.floor() as u32;
                    while (x as f64) < fx1 && x < self.w {
                        let wx = (fx1.min(x as f64 + 1.0) - fx0.max(x as f64)).max(0.0);
                        let wgt = wx * wy;
                        let p = self.pixel(x, y);
                        let a = p[3] as f64 / 255.0;
                        acc[0] += p[0] as f64 * a * wgt;
                        acc[1] += p[1] as f64 * a * wgt;
                        acc[2] += p[2] as f64 * a * wgt;
                        acc[3] += a * wgt;
                        area += wgt;
                        x += 1;
                    }
                    y += 1;
                }
                if area > 0.0 && acc[3] > 0.0 {
                    let a = acc[3] / area;
                    let px = [
                        (acc[0] / acc[3]).round().clamp(0.0, 255.0) as u8,
                        (acc[1] / acc[3]).round().clamp(0.0, 255.0) as u8,
                        (acc[2] / acc[3]).round().clamp(0.0, 255.0) as u8,
                        (a * 255.0).round().clamp(0.0, 255.0) as u8,
                    ];
                    out.set_pixel(ox, oy, px);
                }
            }
        }
        out
    }

    pub fn decode_png(bytes: &[u8]) -> Result<Rgba, String> {
        let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        decoder.set_transformations(png::Transformations::normalize_to_color8());
        let mut reader = decoder.read_info().map_err(|e| format!("png: {e}"))?;
        let mut buf = vec![0; reader.output_buffer_size()];
        let info = reader
            .next_frame(&mut buf)
            .map_err(|e| format!("png: {e}"))?;
        buf.truncate(info.buffer_size());
        let (w, h) = (info.width, info.height);
        let data = match info.color_type {
            png::ColorType::Rgba => buf,
            png::ColorType::Rgb => buf
                .chunks_exact(3)
                .flat_map(|c| [c[0], c[1], c[2], 255])
                .collect(),
            png::ColorType::GrayscaleAlpha => buf
                .chunks_exact(2)
                .flat_map(|c| [c[0], c[0], c[0], c[1]])
                .collect(),
            png::ColorType::Grayscale => buf.iter().flat_map(|&g| [g, g, g, 255]).collect(),
            png::ColorType::Indexed => return Err("png: unexpanded palette".into()),
        };
        Rgba::from_raw(w, h, data)
    }

    pub fn encode_png(&self) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, self.w, self.h);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            enc.set_compression(png::Compression::Default);
            let mut writer = enc.write_header().expect("png header");
            writer.write_image_data(&self.data).expect("png data");
        }
        out
    }

    pub fn to_png_base64(&self) -> String {
        STANDARD.encode(self.encode_png())
    }

    pub fn to_data_url(&self) -> String {
        format!("data:image/png;base64,{}", self.to_png_base64())
    }

    pub fn from_png_base64(b64: &str) -> Result<Rgba, String> {
        let bytes = b64_decode(b64)?;
        Rgba::decode_png(&bytes)
    }
}

pub fn b64_encode(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// Decodes base64, tolerating a `data:*;base64,` prefix.
pub fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    let s = match s.find(";base64,") {
        Some(i) if s.starts_with("data:") => &s[i + 8..],
        _ => s,
    };
    STANDARD
        .decode(s.trim())
        .map_err(|e| format!("base64: {e}"))
}

pub fn png_data_url(png: &[u8]) -> String {
    format!("data:image/png;base64,{}", STANDARD.encode(png))
}

/// Heuristic for 32-bit BGRA bitmaps from GDI: premultiplied data can never
/// have a colour channel above alpha. If any pixel does, it is straight.
pub fn looks_premultiplied_bgra(bgra: &[u8]) -> bool {
    !bgra
        .chunks_exact(4)
        .any(|p| p[0] > p[3] || p[1] > p[3] || p[2] > p[3])
}

/// Converts a GDI top-down BGRA buffer to straight RGBA, un-premultiplying
/// when the data looks premultiplied. A buffer whose alpha is entirely zero
/// but has colour is treated as an opaque (alpha-less) bitmap.
pub fn bgra_to_rgba(w: u32, h: u32, bgra: &[u8]) -> Result<Rgba, String> {
    if bgra.len() != (w as usize) * (h as usize) * 4 {
        return Err("bgra buffer has the wrong size".into());
    }
    let all_zero_alpha = bgra.chunks_exact(4).all(|p| p[3] == 0);
    let has_colour = bgra.chunks_exact(4).any(|p| p[0] | p[1] | p[2] != 0);
    let premul = !all_zero_alpha && looks_premultiplied_bgra(bgra);
    let mut data = Vec::with_capacity(bgra.len());
    for p in bgra.chunks_exact(4) {
        let (b, g, r, a) = (p[0], p[1], p[2], p[3]);
        if all_zero_alpha && has_colour {
            data.extend_from_slice(&[r, g, b, 255]);
        } else if premul && a > 0 && a < 255 {
            let un = |c: u8| ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8;
            data.extend_from_slice(&[un(r), un(g), un(b), a]);
        } else if a == 0 {
            data.extend_from_slice(&[0, 0, 0, 0]);
        } else {
            data.extend_from_slice(&[r, g, b, a]);
        }
    }
    Rgba::from_raw(w, h, data)
}

/// Standard icon sizes, used to snap a detected bbox to its nominal size.
const NOMINAL: [u32; 12] = [16, 20, 24, 32, 40, 48, 64, 72, 96, 128, 180, 256];

/// Shell renderings sometimes place a small icon (16/32/48 px) in the
/// top-left corner of a 256 px canvas. Detect that and crop the canvas to
/// the icon's nominal square so it can be scaled up cleanly. Icons that are
/// merely padded and centred are left alone.
pub fn normalize_corner_icon(img: &Rgba) -> Rgba {
    let Some(b) = img.alpha_bbox(0) else {
        return img.clone();
    };
    let small = b.x1 <= img.w / 2 && b.y1 <= img.h / 2;
    let anchored = b.x0 <= img.w / 16 && b.y0 <= img.h / 16;
    if !(small && anchored) {
        return img.clone();
    }
    let extent = b.x1.max(b.y1);
    let side = NOMINAL
        .iter()
        .copied()
        .find(|&n| n >= extent)
        .unwrap_or(extent)
        .min(img.w)
        .min(img.h);
    img.crop(PixelBox {
        x0: 0,
        y0: 0,
        x1: side,
        y1: side,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_roundtrip() {
        let mut img = Rgba::new(7, 5);
        img.set_pixel(3, 2, [10, 20, 30, 128]);
        let png = img.encode_png();
        let back = Rgba::decode_png(&png).unwrap();
        assert_eq!(img, back);
        let b64 = img.to_png_base64();
        assert_eq!(Rgba::from_png_base64(&b64).unwrap(), img);
        assert_eq!(Rgba::from_png_base64(&img.to_data_url()).unwrap(), img);
    }

    #[test]
    fn premultiplied_detection() {
        // colour <= alpha everywhere: premultiplied
        assert!(looks_premultiplied_bgra(&[10, 10, 10, 20, 0, 0, 0, 0]));
        // red above alpha: straight
        assert!(!looks_premultiplied_bgra(&[0, 0, 200, 100]));
    }

    #[test]
    fn bgra_unpremultiplies() {
        // premultiplied 50% red: r=128, a=128 -> straight r=255
        let img = bgra_to_rgba(1, 1, &[0, 0, 128, 128]).unwrap();
        assert_eq!(img.pixel(0, 0), [255, 0, 0, 128]);
        // straight data (r > a) is kept as is
        let img = bgra_to_rgba(1, 1, &[0, 0, 200, 100]).unwrap();
        assert_eq!(img.pixel(0, 0), [200, 0, 0, 100]);
        // alpha-less bitmap becomes opaque
        let img = bgra_to_rgba(1, 1, &[1, 2, 3, 0]).unwrap();
        assert_eq!(img.pixel(0, 0), [3, 2, 1, 255]);
    }

    #[test]
    fn bbox_and_corner_normalisation() {
        let mut img = Rgba::new(256, 256);
        for y in 1..31 {
            for x in 2..30 {
                img.set_pixel(x, y, [255, 0, 0, 255]);
            }
        }
        assert_eq!(
            img.alpha_bbox(0),
            Some(PixelBox {
                x0: 2,
                y0: 1,
                x1: 30,
                y1: 31
            })
        );
        let n = normalize_corner_icon(&img);
        assert_eq!((n.w, n.h), (32, 32));
        // A centred icon is left alone.
        let mut c = Rgba::new(256, 256);
        for y in 100..156 {
            for x in 100..156 {
                c.set_pixel(x, y, [0, 0, 255, 255]);
            }
        }
        assert_eq!(normalize_corner_icon(&c).w, 256);
        assert!(Rgba::new(4, 4).alpha_bbox(0).is_none());
    }

    #[test]
    fn resize_preserves_colour_at_edges() {
        let mut img = Rgba::new(4, 4);
        img.set_pixel(0, 0, [255, 0, 0, 255]);
        let small = img.resize(2, 2);
        let p = small.pixel(0, 0);
        assert_eq!(&p[..3], &[255, 0, 0]);
        assert_eq!(p[3], 64);
        let big = Rgba::filled(2, 2, [1, 2, 3, 255]).resize(4, 4);
        assert_eq!(big.pixel(3, 3), [1, 2, 3, 255]);
    }
}
