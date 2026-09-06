"""Render a 6-slide SIH 2026 deck for Team Tesseract BTW, then pack it as PPTX."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.util import Inches, Pt

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
FONTS = ROOT / "fonts"
SLIDES = ROOT / "slides"
OUT_PPTX = ROOT / "Tesseract_BTW_SIH2026.pptx"
DESKTOP_PPTX = Path.home() / "Desktop" / "Tesseract_BTW_SIH2026.pptx"

W, H = 1920, 1080

NAVY = (16, 42, 86)
NAVY_DEEP = (10, 28, 58)
ORANGE = (241, 136, 37)
ORANGE_DK = (214, 110, 20)
GREEN = (39, 128, 63)
GREEN_DK = (30, 110, 54)
GREEN_SOFT = (226, 244, 228)
GREEN_BORDER = (72, 168, 92)
RED = (176, 42, 42)
RED_DK = (138, 28, 28)
RED_SOFT = (255, 232, 232)
DARK = (22, 22, 22)
MUTED = (82, 82, 82)
LINE = (220, 224, 228)
WHITE = (255, 255, 255)
OFFWHITE = (250, 251, 252)
PURPLE = (236, 228, 246)
MINT = (226, 246, 222)
SKY = (206, 240, 246)
PEACH = (252, 226, 168)
ICE = (210, 240, 252)
PINK = (255, 220, 220)
GOLD = (196, 148, 42)


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / name), size)


def win_font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(fr"C:\Windows\Fonts\{name}", size)


F_TITLE = lambda s: font("Montserrat-ExtraBold.ttf", s)
F_BOLD = lambda s: font("Montserrat-Bold.ttf", s)
F_SEMI = lambda s: font("Montserrat-SemiBold.ttf", s)
F_MED = lambda s: font("Montserrat-Medium.ttf", s)
F_REG = lambda s: font("Montserrat-Regular.ttf", s)
F_SERIF = lambda s: win_font("georgiab.ttf", s)


def white_to_alpha(im: Image.Image, thresh: int = 248) -> Image.Image:
    im = im.convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r >= thresh and g >= thresh and b >= thresh:
                px[x, y] = (255, 255, 255, 0)
    return im


def trim(im: Image.Image, thresh: int = 248) -> Image.Image:
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    comp = Image.alpha_composite(bg, im)
    gray = comp.convert("L")
    mask = gray.point(lambda p: 255 if p < thresh else 0)
    bbox = mask.getbbox()
    return im.crop(bbox) if bbox else im


def fit(im: Image.Image, box: tuple[int, int], mode: str = "cover") -> Image.Image:
    tw, th = box
    src = im.convert("RGBA")
    sw, sh = src.size
    scale = max(tw / sw, th / sh) if mode == "cover" else min(tw / sw, th / sh)
    nw, nh = max(1, int(sw * scale)), max(1, int(sh * scale))
    src = src.resize((nw, nh), Image.Resampling.LANCZOS)
    if mode == "contain":
        canvas = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
        canvas.paste(src, ((tw - nw) // 2, (th - nh) // 2), src)
        return canvas
    left, top = (nw - tw) // 2, (nh - th) // 2
    return src.crop((left, top, left + tw, top + th))


def circle_crop(im: Image.Image, size: int, zoom: float = 1.0, ox: float = 0.5, oy: float = 0.45) -> Image.Image:
    src = im.convert("RGBA")
    side = int(min(src.size) / zoom)
    cx, cy = int(src.width * ox), int(src.height * oy)
    left = max(0, min(src.width - side, cx - side // 2))
    top = max(0, min(src.height - side, cy - side // 2))
    cropped = src.crop((left, top, left + side, top + side)).resize((size, size), Image.Resampling.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((1, 1, size - 2, size - 2), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(cropped, mask=mask)
    return out


def rounded_mask(size: tuple[int, int], r: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=r, fill=255)
    return mask


def paste_round(base: Image.Image, im: Image.Image, xy: tuple[int, int], size: tuple[int, int], r: int = 18) -> None:
    fitted = fit(im, size, "cover")
    mask = rounded_mask(size, r)
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    layer.paste(fitted, xy, mask)
    composed = Image.alpha_composite(base.convert("RGBA"), layer)
    base.paste(composed.convert(base.mode))


def shadow_rect(img: Image.Image, box: tuple[int, int, int, int], r: int = 18, blur: int = 12, alpha: int = 48) -> None:
    x0, y0, x1, y1 = box
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle((x0 + 4, y0 + 6, x1 + 4, y1 + 6), radius=r, fill=(0, 0, 0, alpha))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    composed = Image.alpha_composite(img.convert("RGBA"), layer)
    img.paste(composed.convert(img.mode))


def rr(draw: ImageDraw.ImageDraw, box, r, fill, outline=None, width=1) -> None:
    draw.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def wrap(draw: ImageDraw.ImageDraw, text: str, fnt, max_w: int) -> list[str]:
    words = text.split()
    lines, cur = [], ""
    for word in words:
        trial = (cur + " " + word).strip()
        if draw.textlength(trial, font=fnt) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines or [""]


def text(draw, xy, s, fnt, fill, anchor="lt") -> None:
    draw.text(xy, s, font=fnt, fill=fill, anchor=anchor)


def multiline(draw, box, s, fnt, fill, lh=None, align="left", max_lines=8) -> int:
    x0, y0, x1, y1 = box
    lines = wrap(draw, s, fnt, x1 - x0)
    lines = lines[:max_lines]
    if lh is None:
        lh = int(fnt.size * 1.28)
    y = y0
    for line in lines:
        w = draw.textlength(line, font=fnt)
        x = x0
        if align == "center":
            x = x0 + (x1 - x0 - w) / 2
        draw.text((x, y), line, font=fnt, fill=fill)
        y += lh
    return y


def hex_bg(img: Image.Image, opacity: int = 38) -> None:
    wm = Image.open(ASSETS / "hex-watermark.png").convert("RGBA").resize((W, H), Image.Resampling.LANCZOS)
    alpha = wm.split()[-1].point(lambda p: int(p * opacity / 255) if p else 0)
    wm.putalpha(alpha)
    composed = Image.alpha_composite(img.convert("RGBA"), wm)
    img.paste(composed.convert(img.mode))


def header(img: Image.Image, title: str) -> None:
    draw = ImageDraw.Draw(img)
    logo = trim(Image.open(ASSETS / "tesseract-logo.png"))
    mark = fit(logo, (72, 72), "contain")
    img.paste(mark, (48, 28), mark)
    text(draw, (128, 36), "TESSERACT", F_TITLE(28), NAVY)
    text(draw, (128, 72), "LOCAL PRIVACY.  REMOTE REASONING.", F_SEMI(11), ORANGE)
    tw = draw.textlength(title, font=F_TITLE(32))
    text(draw, ((W - tw) / 2, 40), title, F_TITLE(32), DARK)
    sih = make_sih_badge(100)
    img.paste(sih, (W - 24 - sih.width, 10), sih)
    draw.line((48, 118, W - 48, 118), fill=LINE, width=2)


def canvas() -> Image.Image:
    img = Image.new("RGB", (W, H), WHITE)
    hex_bg(img, 28)
    return img


def icon_circle(draw, xy, r, bg, glyph: str, glyph_fill=WHITE, fs=22) -> None:
    x, y = xy
    draw.ellipse((x - r, y - r, x + r, y + r), fill=bg)
    if not glyph:
        return
    fnt = F_BOLD(fs)
    text(draw, (x, y + 1), glyph, fnt, glyph_fill, anchor="mm")


def status_mark(draw, xy, ok: bool, r: int = 18) -> None:
    """Drawn tick / cross — Montserrat has no check/cross glyphs."""
    x, y = map(int, xy)
    draw.ellipse((x - r, y - r, x + r, y + r), fill=GREEN if ok else RED)
    w = max(3, r // 4)
    if ok:
        pts = [(x - r * 0.42, y + 0.02 * r), (x - r * 0.12, y + r * 0.38), (x + r * 0.46, y - r * 0.36)]
        draw.line(pts, fill=WHITE, width=w, joint="curve")
    else:
        s = r * 0.38
        draw.line([(x - s, y - s), (x + s, y + s)], fill=WHITE, width=w)
        draw.line([(x + s, y - s), (x - s, y + s)], fill=WHITE, width=w)


def make_sih_badge(h: int = 100) -> Image.Image:
    """Full SIH lockup: complete brain-bulb + 2026 wordmark, no crop."""
    bulb = Image.open(ASSETS / "sih-icon-clean.png").convert("RGBA")
    pad = 10
    padded = Image.new("RGBA", (bulb.width + pad * 2, bulb.height + pad * 2), (0, 0, 0, 0))
    padded.paste(bulb, (pad, pad), bulb)
    bulb = padded
    icon_h = h
    icon_w = max(48, int(icon_h * bulb.width / bulb.height))
    icon = fit(bulb, (icon_w, icon_h), "contain")
    gap = 12
    f_main = F_BOLD(max(14, int(h * 0.20)))
    scratch = Image.new("RGB", (80, 40), WHITE)
    sd = ImageDraw.Draw(scratch)
    tw = max(
        sd.textlength("SMART INDIA", font=f_main),
        sd.textlength("HACKATHON", font=f_main),
        sd.textlength("2026", font=f_main),
    )
    out = Image.new("RGBA", (icon_w + gap + int(tw) + 12, h), (0, 0, 0, 0))
    out.paste(icon, (0, 0), icon)
    d = ImageDraw.Draw(out)
    tx = icon_w + gap
    d.text((tx, int(h * 0.06)), "SMART INDIA", font=f_main, fill=NAVY)
    d.text((tx, int(h * 0.36)), "HACKATHON", font=f_main, fill=NAVY)
    d.text((tx, int(h * 0.66)), "2026", font=f_main, fill=NAVY)
    return out


def mini_icon(draw, xy, kind: str, color=WHITE) -> None:
    x, y = xy
    if kind == "lock":
        draw.rounded_rectangle((x - 7, y - 2, x + 7, y + 8), 2, outline=color, width=2)
        draw.arc((x - 5, y - 10, x + 5, y), start=200, end=340, fill=color, width=2)
    elif kind == "shield":
        draw.polygon([(x, y + 9), (x - 8, y - 2), (x - 8, y - 8), (x + 8, y - 8), (x + 8, y - 2)], outline=color)
        draw.line((x, y - 4, x, y + 4), fill=color, width=2)
    elif kind == "id":
        draw.rounded_rectangle((x - 9, y - 7, x + 9, y + 7), 2, outline=color, width=2)
        draw.ellipse((x - 6, y - 4, x - 1, y + 1), outline=color, width=1)
        draw.line((x + 1, y - 2, x + 6, y - 2), fill=color, width=2)
    elif kind == "face":
        draw.ellipse((x - 8, y - 8, x + 8, y + 8), outline=color, width=2)
        draw.ellipse((x - 4, y - 3, x - 2, y - 1), fill=color)
        draw.ellipse((x + 2, y - 3, x + 4, y - 1), fill=color)
        draw.arc((x - 4, y - 1, x + 4, y + 6), start=20, end=160, fill=color, width=2)
    elif kind == "check":
        draw.line([(x - 6, y), (x - 1, y + 5), (x + 7, y - 6)], fill=color, width=2)
    elif kind == "scale":
        draw.polygon([(x - 8, y + 7), (x, y - 8), (x + 8, y + 7)], outline=color)
        draw.line((x, y - 2, x, y + 7), fill=color, width=2)


def dashed_circle(draw, c, r, color, width=3, dash=14, gap=8) -> None:
    cx, cy = c
    n = int(2 * math.pi * r)
    on = True
    acc = 0
    pts = []
    for i in range(n + 1):
        t = 2 * math.pi * i / n
        pts.append((cx + r * math.cos(t), cy + r * math.sin(t)))
    i = 0
    while i < len(pts) - 1:
        run = dash if on else gap
        j = min(len(pts) - 1, i + run)
        if on:
            draw.line(pts[i:j + 1], fill=color, width=width, joint="curve")
        on = not on
        i = j


def pill(draw, xy, label, bg, fg, fnt=None) -> None:
    fnt = fnt or F_SEMI(14)
    pad_x, pad_y = 14, 7
    w = int(draw.textlength(label, font=fnt)) + pad_x * 2
    h = fnt.size + pad_y * 2
    x, y = xy
    rr(draw, (x, y, x + w, y + h), 18, bg)
    text(draw, (x + w / 2, y + h / 2), label, fnt, fg, anchor="mm")
    return w + 10


# ---------------------------------------------------------------------------
# Slides
# ---------------------------------------------------------------------------

def slide_1() -> Image.Image:
    img = canvas()
    hex_bg(img, 55)
    draw = ImageDraw.Draw(img)
    sih = make_sih_badge(96)
    img.paste(sih, (W - 28 - sih.width, 22), sih)

    heading = "SMART INDIA HACKATHON 2026"
    hw = draw.textlength(heading, font=F_SERIF(46))
    text(draw, ((W - hw) / 2, 48), heading, F_SERIF(46), NAVY)
    sub = "TITLE PAGE"
    sw = draw.textlength(sub, font=F_SERIF(28))
    text(draw, ((W - sw) / 2, 108), sub, F_SERIF(28), DARK)

    rows = [
        ("Problem Statement ID  —", "26171", GREEN_DK),
        ("Problem Statement Title  —", "On-device Visual Perception for Light-weight Browser Agents", ORANGE_DK),
        ("Organisation  —", "Indian Space Research Organisation (ISRO)", DARK),
        ("Theme  —", "Smart Automation", DARK),
        ("PS Category  —", "Software", DARK),
        ("Team ID  —", "—", DARK),
        ("Team Name  :", "Tesseract BTW", NAVY),
    ]
    y = 210
    left = 86
    for label, value, color in rows:
        text(draw, (left, y), "•", F_BOLD(26), NAVY)
        text(draw, (left + 36, y + 4), label, F_BOLD(26), DARK)
        lw = draw.textlength(label, font=F_BOLD(26))
        vx = left + 36 + lw + 16
        if label.startswith("Problem Statement Title"):
            multiline(draw, (vx, y + 2, 1180, y + 120), value, F_BOLD(24), color, lh=34, max_lines=3)
            y += 108
        else:
            text(draw, (vx, y + 2), value, F_BOLD(26), color)
            y += 62

    text(draw, (left + 36, 780), "Privacy-Preserving Browser Agent", F_TITLE(22), NAVY)
    multiline(
        draw,
        (left + 36, 822, 1180, 920),
        "A local privacy proxy between the webpage and the reasoning model — on-device perception, redaction before the network, constrained actions after.",
        F_MED(16),
        MUTED,
        lh=24,
        max_lines=3,
    )

    hero = Image.open(ASSETS / "sih-icon-clean.png").convert("RGBA")
    hero = fit(hero, (460, 720), "contain")
    hx = W - 56 - hero.width
    hy = 190
    img.paste(hero, (hx, hy), hero)

    rr(draw, (86, 980, 1180, 1040), 16, NAVY)
    text(
        draw,
        (633, 1010),
        "Chrome extension  ·  On-device redaction  ·  Constrained browser agent",
        F_SEMI(15),
        WHITE,
        anchor="mm",
    )
    return img


def slide_2() -> Image.Image:
    img = canvas()
    header(img, "PROPOSED SOLUTION")
    draw = ImageDraw.Draw(img)

    features = [
        ("1. Local Visual Perception", "On-device YuNet face detection plus DOM-first screen reading. The raw screenshot never leaves the machine."),
        ("2. Layered PII Detection", "Field purpose, checksum validators for Aadhaar / PAN / GSTIN / cards, then English NER only where regex fails."),
        ("3. Privacy-Preserving Filter", "Typed placeholders, padded black-box masks, one-way password / OTP / CVV tokens. Vault stays in the tab."),
        ("4. Constrained Browser Agent", "Closed action vocabulary, current element ids, user approval for submit / purchase. No model-written JavaScript."),
        ("5. Sanitized Server Planning", "Only anonymized context reaches the LLM. The server returns click, type and scroll — never secrets."),
    ]
    y = 128
    for title, body in features:
        box = (40, y, 560, y + 168)
        shadow_rect(img, box, 16, 8, 36)
        draw = ImageDraw.Draw(img)
        rr(draw, box, 16, GREEN_SOFT, GREEN_BORDER, 3)
        text(draw, (62, y + 16), title, F_BOLD(18), NAVY)
        multiline(draw, (62, y + 50, 536, y + 150), body, F_REG(14), MUTED, lh=20, max_lines=5)
        y += 180

    # Reality photo
    photo_box = (584, 128, 1468, 470)
    shadow_rect(img, photo_box, 18, 10, 50)
    paste_round(img, Image.open(ASSETS / "problem-reality.png"), (584, 128), (884, 342), 18)
    draw = ImageDraw.Draw(img)
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rounded_rectangle((584, 128, 1468, 210), radius=18, fill=(10, 16, 28, 168))
    od.rectangle((584, 176, 1468, 210), fill=(10, 16, 28, 168))
    img.paste(Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB"))
    draw = ImageDraw.Draw(img)
    text(draw, (604, 146), "THE REALITY TODAY", F_BOLD(16), ORANGE)
    text(
        draw,
        (604, 174),
        "Cloud agents see Aadhaar, PAN, faces, passwords and bank fields on the live screen.",
        F_MED(14),
        WHITE,
    )
    rr(draw, (584, 428, 1468, 470), 0, NAVY_DEEP)
    # flatten bottom of photo caption
    draw.rectangle((584, 428, 1468, 470), fill=NAVY_DEEP)
    text(
        draw,
        (1026, 449),
        "RAW SCREEN  ·  RAW PII  ·  RAW TRUST GAP",
        F_BOLD(13),
        WHITE,
        anchor="mm",
    )

    # Benefits
    draw.rectangle((584, 486, 1468, 548), fill=NAVY)
    text(draw, (620, 517), "BENEFITS", F_BOLD(14), WHITE, anchor="lm")
    benefits = [
        ("PII stays local", GREEN),
        ("Checksum IDs", ORANGE),
        ("Face masks", GREEN),
        ("Closed actions", ORANGE),
        ("DPDP-aligned", GREEN),
    ]
    x = 760
    for label, col in benefits:
        status_mark(draw, (x, 517), True, r=11)
        text(draw, (x + 20, 517), label, F_SEMI(12), WHITE, anchor="lm")
        x += 138

    # UI mockups
    mocks = [
        (ASSETS / "ui-analyze.png", "ANALYZE PAGE"),
        (ASSETS / "ui-sanitized.png", "SANITIZED SCREEN"),
        (ASSETS / "ui-actions.png", "VALIDATED ACTIONS"),
    ]
    mx = 584
    for path, cap in mocks:
        shadow_rect(img, (mx, 564, mx + 284, 1044), 16, 8, 40)
        paste_round(img, Image.open(path), (mx, 564), (284, 430), 16)
        draw = ImageDraw.Draw(img)
        rr(draw, (mx, 994, mx + 284, 1044), 0, NAVY)
        draw.rectangle((mx, 994, mx + 284, 1044), fill=NAVY)
        text(draw, (mx + 142, 1019), cap, F_BOLD(12), WHITE, anchor="mm")
        mx += 298

    # Challenges
    ch_box = (1500, 128, 1880, 1044)
    shadow_rect(img, ch_box, 20, 10, 50)
    draw = ImageDraw.Draw(img)
    rr(draw, ch_box, 20, RED_DK)
    text(draw, (1690, 158), "CURRENT", F_TITLE(20), WHITE, anchor="mm")
    text(draw, (1690, 188), "CHALLENGES", F_TITLE(20), WHITE, anchor="mm")
    challenges = [
        ("01", "Raw screenshots", "Cloud GUI agents upload the live screen, secrets included."),
        ("02", "Indian identifiers", "Aadhaar, PAN, GSTIN and UPI sit in ordinary page text."),
        ("03", "Faces & documents", "Portraits and ID photos leak through pixel pipelines."),
        ("04", "Unconstrained actions", "A model that can run JS can exfiltrate or destroy data."),
        ("05", "Browser budget", "A full VLM will not fit; latency and RAM are real limits."),
        ("06", "Trust gap", "Users will not adopt agents that treat PII as context."),
    ]
    y = 230
    for num, title, body in challenges:
        rr(draw, (1520, y, 1860, y + 122), 14, (158, 34, 34))
        icon_circle(draw, (1552, y + 28), 16, ORANGE, num, WHITE, 11)
        text(draw, (1578, y + 16), title, F_BOLD(15), WHITE)
        multiline(draw, (1528, y + 50, 1848, y + 112), body, F_REG(13), (255, 224, 224), lh=18, max_lines=3)
        y += 132
    return img


def slide_3() -> Image.Image:
    img = canvas()
    header(img, "Technical Approach")
    draw = ImageDraw.Draw(img)

    text(draw, (60, 128), "SYSTEM WORKFLOW", F_TITLE(18), NAVY)
    steps = [
        ("1", "User starts Analyze or Run agent from the popup."),
        ("2", "Service worker injects the content script on demand — never on every page load."),
        ("3", "Visible DOM is extracted with stable element_N ids."),
        ("4", "Rules + checksums redact PII. The vault is minted inside the tab."),
        ("5", "Offscreen WASM runs YuNet, DistilBERT NER and selective OCR."),
        ("6", "Screenshot sanitizer paints padded black masks for secrets and faces."),
        ("7", "Privacy gateway rejects unsanitized or leaking payloads."),
        ("8", "LLM returns a closed action list. The extension validates, confirms and applies locally."),
    ]
    y = 168
    for i, (num, body) in enumerate(steps):
        cx, cy = 86, y + 22
        if i < len(steps) - 1:
            draw.line((cx, cy + 22, cx, y + 86), fill=(120, 170, 220), width=3)
        icon_circle(draw, (cx, cy), 18, GREEN, num, WHITE, 14)
        rr(draw, (118, y, 760, y + 72), 12, OFFWHITE, LINE, 1)
        multiline(draw, (134, y + 12, 744, y + 66), body, F_MED(14), DARK, lh=20, max_lines=2)
        y += 86

    # Tech stack
    rr(draw, (48, 868, 760, 1044), 18, NAVY)
    text(draw, (72, 888), "TECH STACK", F_TITLE(18), WHITE)
    stack = [
        "Chrome MV3", "Vanilla JS", "ONNX Runtime Web", "OpenCV YuNet 232 KB",
        "DistilBERT NER q8", "Tesseract.js", "Express gateway", "OpenAI-compatible LLM",
        "Mock provider", "Playwright E2E",
    ]
    x, y = 72, 932
    for label in stack:
        fnt = F_SEMI(13)
        pw = int(draw.textlength(label, font=fnt)) + 28
        if x + pw > 740:
            x = 72
            y += 42
        rr(draw, (x, y, x + pw, y + 32), 16, (28, 64, 118))
        text(draw, (x + pw / 2, y + 16), label, fnt, WHITE, anchor="mm")
        x += pw + 10

    # Architecture
    text(draw, (800, 128), "SMART WORKFLOW OF THE AGENT", F_TITLE(18), NAVY)
    arch = [
        ((800, 168, 1088, 268), NAVY, WHITE, "USER CHANNEL", "Chrome popup · consent · policy toggles · sanitized preview"),
        ((1148, 168, 1488, 268), (30, 90, 160), WHITE, "ORCHESTRATOR", "MV3 service worker · inject · capture · agent loop"),
        ((1548, 168, 1880, 268), GREEN_DK, WHITE, "PAGE CONTEXT", "Isolated content script · DOM · vault · apply"),
        ((800, 300, 1188, 430), (92, 58, 140), WHITE, "OFFSCREEN MODELS", "YuNet faces · DistilBERT names · Tesseract OCR · WASM / ONNX"),
        ((1228, 300, 1880, 430), RED_DK, WHITE, "TRUST BOUNDARY", "Vault never leaves the tab. Passwords / OTP / CVV are one-way tokens. Raw PNG never accepted on the wire."),
        ((800, 462, 1320, 600), (20, 110, 130), WHITE, "PRIVACY GATEWAY  :4317", "Structural validation · leak scan · branded JPEG · mock or OpenAI-compatible planner"),
        ((1360, 462, 1880, 600), ORANGE_DK, WHITE, "PLANNER", "Closed JSON actions only: click, type, fill_from_vault, scroll, wait, done"),
        ((800, 632, 1880, 780), (36, 70, 48), WHITE, "LOCAL EXECUTION", "Validate ids twice · refuse credential fills · confirm submit/purchase · expand placeholders only inside the isolated world · re-extract each turn (max 6 / 90s)"),
    ]
    for box, bg, fg, title, body in arch:
        shadow_rect(img, box, 16, 8, 34)
        draw = ImageDraw.Draw(img)
        rr(draw, box, 16, bg)
        text(draw, (box[0] + 18, box[1] + 14), title, F_BOLD(15), fg)
        multiline(draw, (box[0] + 18, box[1] + 44, box[2] - 16, box[3] - 12), body, F_REG(14), (240, 244, 248) if fg == WHITE else MUTED, lh=20, max_lines=4)

    draw = ImageDraw.Draw(img)
    # arrows
    def arrow(a, b):
        draw.line((a, b), fill=NAVY, width=3)
        ang = math.atan2(b[1] - a[1], b[0] - a[0])
        for da in (2.5, -2.5):
            draw.line((b, (b[0] - 12 * math.cos(ang + da / 6), b[1] - 12 * math.sin(ang + da / 6))), fill=NAVY, width=3)

    arrow((1088, 218), (1148, 218))
    arrow((1488, 218), (1548, 218))
    arrow((944, 268), (944, 300))
    arrow((1554, 268), (1554, 300))
    arrow((994, 430), (994, 462))
    arrow((1620, 430), (1620, 462))
    arrow((1060, 600), (1060, 632))

    rr(draw, (800, 804, 1880, 1044), 18, OFFWHITE, LINE, 2)
    text(draw, (824, 824), "WHY THIS SHAPE EXISTS", F_BOLD(16), NAVY)
    notes = [
        "Popup cannot read a tab. Service worker cannot host long WASM. Only the content script can keep a vault next to the live DOM.",
        "Models are used only where checksums and DOM facts are not enough: names, faces, painted text.",
        "The remote model proposes intent. Deterministic code owns authority, ids, and secret expansion.",
    ]
    y = 864
    for n in notes:
        text(draw, (824, y), "▸", F_BOLD(16), ORANGE)
        multiline(draw, (852, y, 1856, y + 50), n, F_REG(15), MUTED, lh=22, max_lines=2)
        y += 56
    return img


def slide_4() -> Image.Image:
    img = canvas()
    header(img, "Feasibility & Viability")
    cards = [
        (PURPLE, "1. Analysing the feasibility of the idea", [
            "Easy to implement: Chrome MV3, WASM and ONNX Runtime Web — no native app, no new hardware.",
            "Lightweight: YuNet is ~232 KB and packaged locally; DistilBERT q8 loads once and is cached.",
            "Measured: 16-page rule corpus, 100% precision, 90.2% F1. Safety, server and E2E suites are separate.",
            "Demo-ready: mock planner runs fully offline; cloud LLM is a config switch, not an architecture change.",
        ]),
        (MINT, "Potential Challenges & Risks", [
            "Indic names in prose: English DistilBERT recall does not cover Devanagari person names.",
            "No labelled pixel corpus yet: YuNet/OCR run in E2E tests, but face IoU / over-redaction are not scored.",
            "Hybrid-mode gap: local vision can run without those detections reaching the planner.",
            "Detection defines coverage: novel IDs and some bank-account shapes can still slip through.",
        ]),
        (SKY, "2. Strategies for overcoming these challenges", [
            "Strongest-first evidence: Verhoeff / Luhn / GSTIN checksums before any model confidence score.",
            "Lazy, offscreen inference so the service worker stays event-driven and the UI does not freeze.",
            "Dual gates: extension and server both reject raw fields, vault values and unknown actions.",
            "Separate eval families: rule F1, safety suite, server tests, and real-browser E2E — never mixed.",
        ]),
        (PEACH, "Evaluation of Long-Term Sustainability", [
            "Scalable: a Chrome/Edge extension can move from one machine → campus → department → nationwide.",
            "Policy fit: local minimisation matches DPDP 2023 and the ISRO brief to send only non-sensitive structure.",
            "Improving data: more pages and a labelled pixel set raise recall without enlarging the trust boundary.",
            "Adaptable: swap the planner (mock, Ollama, OpenRouter) without touching redaction or the vault.",
        ]),
    ]
    positions = [(48, 132, 936, 588), (984, 132, 1872, 588), (48, 612, 936, 1044), (984, 612, 1872, 1044)]
    deco = fit(trim(Image.open(ASSETS / "tesseract-logo.png")), (120, 120), "contain")
    deco.putalpha(deco.split()[-1].point(lambda p: int(p * 0.18)))
    for box, (bg, title, bullets) in zip(positions, cards):
        shadow_rect(img, box, 22, 10, 40)
        draw = ImageDraw.Draw(img)
        rr(draw, box, 22, bg)
        img.paste(deco, (box[2] - 148, box[3] - 148), deco)
        draw = ImageDraw.Draw(img)
        text(draw, (box[0] + 28, box[1] + 24), title, F_BOLD(20), NAVY)
        y = box[1] + 78
        for b in bullets:
            icon_circle(draw, (box[0] + 44, y + 12), 8, ORANGE, "", WHITE, 8)
            y = multiline(draw, (box[0] + 64, y, box[2] - 36, y + 90), b, F_REG(16), DARK, lh=22, max_lines=3) + 16
    return img


def slide_5() -> Image.Image:
    img = canvas()
    header(img, "Impacts and Benefits")
    draw = ImageDraw.Draw(img)
    text(draw, (60, 128), "Impact Created on Society", F_TITLE(20), NAVY)

    impacts = [
        ((220, 430), "Our Social Impact", "Citizens can use agents on DigiLocker, banks and government portals without handing over Aadhaar, PAN or passwords."),
        ((560, 430), "Digital Transformation", "Turns the agentic web from “upload the screen” into a privacy proxy: local evidence, remote reasoning, local action."),
        ((220, 860), "Environmental Impact", "On-device WASM inference and a 232 KB face model avoid shipping every screenshot to a GPU cluster."),
        ((560, 860), "Government Impact", "Fits ISRO’s brief: only non-sensitive structure leaves the client. Path from one workstation → organisation → national scale."),
    ]
    for (cx, cy), label, body in impacts:
        dashed_circle(draw, (cx, cy), 148, GREEN, 3, 16, 10)
        draw.ellipse((cx - 132, cy - 132, cx + 132, cy + 132), fill=WHITE, outline=GREEN_SOFT, width=2)
        lw = max(210, int(draw.textlength(label, font=F_BOLD(13)) + 28))
        rr(draw, (cx - lw / 2, cy - 168, cx + lw / 2, cy - 132), 12, PINK)
        text(draw, (cx, cy - 150), label, F_BOLD(13), RED_DK, anchor="mm")
        multiline(draw, (cx - 112, cy - 70, cx + 112, cy + 110), body, F_MED(14), DARK, lh=20, align="center", max_lines=6)

    # Right benefits
    portrait = circle_crop(Image.open(ASSETS / "citizen.png"), 280, zoom=1.05, ox=0.48, oy=0.38)
    ring = Image.new("RGBA", (312, 312), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    rd.ellipse((2, 2, 309, 309), outline=GREEN, width=8)
    img.paste(ring, (1194, 430), ring)
    img.paste(portrait, (1210, 446), portrait)

    benefits = [
        (820, 160, "No raw PII to the cloud", "Redacted DOM + masked JPEG only."),
        (1180, 160, "Saves user trust", "Secrets stay in the tab-local vault."),
        (1540, 160, "Indian ID intelligence", "Verhoeff, Luhn, GSTIN, PAN, IFSC."),
        (820, 860, "Faces blacked out", "YuNet boxes become padded masks."),
        (1180, 860, "Safe agency", "Closed vocabulary, confirmations, 6-turn cap."),
        (1540, 860, "Scalable extension", "Chrome/Edge today; same privacy contract later."),
    ]
    icons = ["lock", "shield", "id", "face", "check", "scale"]
    colors = [ICE, ICE, ICE, ICE, ICE, ICE]
    for (x, y, title, body), kind, bg in zip(benefits, icons, colors):
        box = (x, y, x + 300, y + 118)
        shadow_rect(img, box, 14, 7, 36)
        draw = ImageDraw.Draw(img)
        rr(draw, box, 14, bg, NAVY, 1)
        icon_circle(draw, (x + 28, y + 32), 16, NAVY, "", WHITE, 12)
        mini_icon(draw, (x + 28, y + 32), kind, WHITE)
        text(draw, (x + 54, y + 18), title, F_BOLD(14), NAVY)
        multiline(draw, (x + 18, y + 58, x + 284, y + 108), body, F_REG(13), MUTED, lh=18, max_lines=2)
    return img


def slide_6() -> Image.Image:
    img = canvas()
    header(img, "Research & References")
    draw = ImageDraw.Draw(img)

    # Research workflow
    cx, cy = 370, 340
    nodes = [
        (370, 188, "CHOOSING PROBLEM\nSTATEMENT"),
        (590, 340, "ANALYSIS OF\nEXISTING AGENTS"),
        (370, 492, "DESIGN LAYERED\nPRIVACY STACK"),
        (150, 340, "EVAL, SAFETY\nGATES, DEMO"),
    ]
    pairs = [(0, 1), (1, 2), (2, 3), (3, 0)]
    for a, b in pairs:
        x0, y0, _ = nodes[a]
        x1, y1, _ = nodes[b]
        draw.line((x0, y0, x1, y1), fill=(160, 168, 176), width=3)
    draw.ellipse((cx - 78, cy - 78, cx + 78, cy + 78), fill=WHITE, outline=NAVY, width=4)
    multiline(draw, (cx - 64, cy - 24, cx + 64, cy + 28), "Research Workflow", F_BOLD(13), NAVY, lh=18, align="center", max_lines=2)
    for x, y, label in nodes:
        rr(draw, (x - 112, y - 32, x + 112, y + 32), 22, NAVY)
        multiline(draw, (x - 102, y - 20, x + 102, y + 24), label.replace("\n", " "), F_SEMI(11), WHITE, lh=14, align="center", max_lines=2)

    # References
    rr(draw, (48, 600, 700, 1044), 18, NAVY)
    text(draw, (72, 624), "SIH26171  |  ISRO  |  DPDP 2023  |  MV3", F_BOLD(14), ORANGE)
    refs = [
        "SIH 2026 PS SIH26171 — On-device Visual Perception for Light-weight Browser Agents (ISRO / Department of Space).",
        "ONNX Runtime Web + OpenCV YuNet 2023mar — compact on-device face detection.",
        "Hugging Face Transformers.js / DistilBERT NER (q8) — English names after rule redaction.",
        "Tesseract.js — selective OCR for image, canvas and video text.",
        "Digital Personal Data Protection Act, 2023 — purpose limitation and minimisation.",
        "Chrome Manifest V3 + Offscreen Documents — event-driven privacy architecture.",
        "UIDAI Verhoeff checksum, Luhn (cards), GSTIN mod-36 — exact Indian identifier tests.",
        "Minim / MaskClaw (2026) — edge-side sanitization for GUI agents before cloud reasoning.",
    ]
    y = 668
    for i, ref in enumerate(refs, 1):
        text(draw, (72, y), f"{i}.", F_BOLD(13), ORANGE)
        y = multiline(draw, (100, y, 676, y + 44), ref, F_REG(13), WHITE, lh=18, max_lines=2) + 8

    # Comparison table
    text(draw, (740, 128), "COMPARISON WITH EXISTING APPROACHES", F_TITLE(18), NAVY)
    headers = ["FEATURES", "Cloud GUI\nagents", "Browser\ncopilots", "Password\nmanagers", "TESSERACT"]
    cols_x = [740, 1048, 1248, 1448, 1648]
    col_w = [308, 200, 200, 200, 224]
    row_h = 78
    header_h = 86
    features = [
        "On-device visual perception",
        "Redact before any network call",
        "Indian ID checksums (Aadhaar/PAN/GSTIN)",
        "Face & screenshot masking",
        "Typed placeholders for the planner",
        "Closed action vocabulary",
        "Tab-local secret vault",
        "Offline mock + optional cloud LLM",
        "Working Chrome MV3 prototype",
    ]
    matrix = [
        [0, 0, 0, 1],
        [0, 0, 0, 1],
        [0, 0, 0, 1],
        [0, 0, 0, 1],
        [0, 0, 0, 1],
        [0, 0, 0, 1],
        [0, 0, 1, 1],
        [0, 0, 0, 1],
        [0, 1, 1, 1],
    ]
    head_colors = [NAVY, GREEN_DK, (92, 58, 140), ORANGE_DK, NAVY_DEEP]
    y = 172
    for i, (label, color) in enumerate(zip(headers, head_colors)):
        x = cols_x[i]
        rr(draw, (x, y, x + col_w[i] - 8, y + header_h), 10, color)
        multiline(draw, (x + 8, y + 18, x + col_w[i] - 16, y + header_h), label.replace("\n", " "), F_BOLD(13), WHITE, lh=18, align="center", max_lines=2)

    y = 172 + header_h + 8
    for r, feat in enumerate(features):
        bg = OFFWHITE if r % 2 == 0 else WHITE
        draw.rectangle((740, y, 1864, y + row_h), fill=bg)
        multiline(draw, (752, y + 18, 1036, y + row_h), feat, F_SEMI(14), DARK, lh=20, max_lines=2)
        for c, val in enumerate(matrix[r]):
            cx = cols_x[c + 1] + col_w[c + 1] / 2 - 4
            cy = y + row_h / 2
            if val:
                status_mark(draw, (cx, cy), True, r=16)
            else:
                status_mark(draw, (cx, cy), False, r=16)
        y += row_h

    draw.line((740, y, 1864, y), fill=LINE, width=2)
    text(
        draw,
        (740, 1020),
        "Tesseract is the only column that combines on-device perception, Indian identifier intelligence, and a constrained agent.",
        F_MED(13),
        MUTED,
    )
    return img


def pack_pptx(paths: list[Path]) -> None:
    prs = Presentation()
    prs.slide_width = Inches(13.333333)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]
    for path in paths:
        slide = prs.slides.add_slide(blank)
        slide.shapes.add_picture(str(path), Inches(0), Inches(0), width=prs.slide_width, height=prs.slide_height)
        # invisible title for accessibility / outline
        box = slide.shapes.add_textbox(Inches(0), Inches(0), Inches(0.1), Inches(0.1))
        box.text_frame.paragraphs[0].font.size = Pt(1)
        box.text_frame.paragraphs[0].font.color.rgb = RGBColor(255, 255, 255)
    prs.save(OUT_PPTX)
    try:
        prs.save(DESKTOP_PPTX)
    except PermissionError:
        alt = Path.home() / "Desktop" / "Tesseract_BTW_SIH2026_updated.pptx"
        prs.save(alt)
        print("desktop file was open; saved", alt)


def main() -> None:
    SLIDES.mkdir(parents=True, exist_ok=True)
    builders = [slide_1, slide_2, slide_3, slide_4, slide_5, slide_6]
    paths = []
    for i, fn in enumerate(builders, 1):
        im = fn()
        path = SLIDES / f"slide-{i}.png"
        im.save(path, "PNG", optimize=True)
        print("wrote", path, im.size)
        paths.append(path)
    pack_pptx(paths)
    print("pptx", OUT_PPTX)
    print("desktop", DESKTOP_PPTX)


if __name__ == "__main__":
    main()
