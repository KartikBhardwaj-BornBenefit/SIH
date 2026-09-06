"""Build an editable SIH 2026 PPTX for Team Tesseract BTW.

All titles, body copy, table cells, and shape labels are native PowerPoint
objects. Pictures are used only for logos, photos, and UI mockups.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
OUT = ROOT / "Tesseract_BTW_SIH2026_editable.pptx"
DESKTOP = Path.home() / "Desktop" / "Tesseract_BTW_SIH2026_editable.pptx"

# 1920x1080 -> 13.333" x 7.5"  (144 px per inch)
SW, SH = 13.333333, 7.5


def px(n: float) -> Emu:
    return Inches(n / 144.0)


NAVY = RGBColor(16, 42, 86)
NAVY_DEEP = RGBColor(10, 28, 58)
ORANGE = RGBColor(241, 136, 37)
ORANGE_DK = RGBColor(214, 110, 20)
GREEN = RGBColor(39, 128, 63)
GREEN_DK = RGBColor(30, 110, 54)
GREEN_SOFT = RGBColor(226, 244, 228)
GREEN_BORDER = RGBColor(72, 168, 92)
RED = RGBColor(176, 42, 42)
RED_DK = RGBColor(138, 28, 28)
DARK = RGBColor(22, 22, 22)
MUTED = RGBColor(82, 82, 82)
LINE = RGBColor(220, 224, 228)
WHITE = RGBColor(255, 255, 255)
OFFWHITE = RGBColor(250, 251, 252)
PURPLE = RGBColor(236, 228, 246)
MINT = RGBColor(226, 246, 222)
SKY = RGBColor(206, 240, 246)
PEACH = RGBColor(252, 226, 168)
ICE = RGBColor(210, 240, 252)
PINK = RGBColor(255, 220, 220)
BLUE_MID = RGBColor(30, 90, 160)
PURPLE_DK = RGBColor(92, 58, 140)
TEAL = RGBColor(20, 110, 130)
FOREST = RGBColor(36, 70, 48)
RED_CARD = RGBColor(158, 34, 34)
PILL = RGBColor(28, 64, 118)
FONT = "Calibri"
FONT_SERIF = "Georgia"
FONT_SYM = "Segoe UI Symbol"


def circle_mask(src: Path, dest: Path) -> Path:
    """Keep the inscribed photo circle; make the black square corners transparent."""
    im = Image.open(src).convert("RGBA")
    w, h = im.size
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, w - 1, h - 1), fill=255)
    im.putalpha(mask)
    dest.parent.mkdir(parents=True, exist_ok=True)
    im.save(dest)
    return dest


def trim_white(src: Path, dest: Path, thresh: int = 248) -> Path:
    im = Image.open(src).convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    gray = Image.alpha_composite(bg, im).convert("L")
    mask = gray.point(lambda p: 255 if p < thresh else 0)
    bbox = mask.getbbox()
    if bbox:
        im = im.crop(bbox)
    dest.parent.mkdir(parents=True, exist_ok=True)
    im.save(dest)
    return dest


def rgb_fill(shape, color: RGBColor, line: RGBColor | None = None, weight: float = 1.0) -> None:
    shape.fill.solid()
    shape.fill.fore_color.rgb = color
    if line is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = line
        shape.line.width = Pt(weight)


def _set_run(run, text: str, size: float, bold: bool, color: RGBColor, name: str = FONT) -> None:
    run.text = text
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    run.font.name = name
    run.font.italic = False


def write_tf(tf, lines: list[tuple[str, float, bool, RGBColor, str]], align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, spacing: float = 1.0) -> None:
    tf.clear()
    tf.word_wrap = True
    tf.auto_size = None
    try:
        tf.vertical_anchor = anchor
    except Exception:
        pass
    for i, (text, size, bold, color, name) in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.space_before = Pt(0)
        p.space_after = Pt(0)
        p.line_spacing = spacing
        if p.runs:
            _set_run(p.runs[0], text, size, bold, color, name)
        else:
            _set_run(p.add_run(), text, size, bold, color, name)


def add_box(slide, l, t, w, h, fill: RGBColor, line: RGBColor | None = None, radius: float = 0.08):
    shp = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, l, t, w, h)
    rgb_fill(shp, fill, line, 1.5 if line else 1.0)
    try:
        shp.adjustments[0] = radius
    except Exception:
        pass
    shp.shadow.inherit = False
    return shp


def add_rect(slide, l, t, w, h, fill: RGBColor, line: RGBColor | None = None):
    shp = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, l, t, w, h)
    rgb_fill(shp, fill, line)
    shp.shadow.inherit = False
    return shp


def add_oval(slide, l, t, w, h, fill: RGBColor, line: RGBColor | None = None, weight: float = 1.5):
    shp = slide.shapes.add_shape(MSO_SHAPE.OVAL, l, t, w, h)
    rgb_fill(shp, fill, line, weight)
    shp.shadow.inherit = False
    return shp


def add_tb(slide, l, t, w, h, text: str, size: float, bold: bool, color: RGBColor, align=PP_ALIGN.LEFT, font: str = FONT, anchor=MSO_ANCHOR.TOP):
    box = slide.shapes.add_textbox(l, t, w, h)
    tf = box.text_frame
    tf.word_wrap = True
    tf.margin_left = Inches(0.04)
    tf.margin_right = Inches(0.04)
    tf.margin_top = Inches(0.02)
    tf.margin_bottom = Inches(0.02)
    write_tf(tf, [(text, size, bold, color, font)], align=align, anchor=anchor)
    return box


def add_runs(slide, l, t, w, h, runs: list[tuple[str, float, bool, RGBColor, str]], align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE):
    """One paragraph, multiple colored runs (for label + value)."""
    box = slide.shapes.add_textbox(l, t, w, h)
    tf = box.text_frame
    tf.word_wrap = True
    tf.margin_left = Inches(0.02)
    tf.margin_right = Inches(0.02)
    tf.margin_top = Inches(0.02)
    tf.margin_bottom = Inches(0.02)
    try:
        tf.vertical_anchor = anchor
    except Exception:
        pass
    p = tf.paragraphs[0]
    p.alignment = align
    p.space_before = Pt(0)
    p.space_after = Pt(0)
    for text, size, bold, color, name in runs:
        _set_run(p.add_run(), text, size, bold, color, name)
    return box


def shape_copy(shape, title: str, body: str, title_size=13, body_size=11, title_c=WHITE, body_c=WHITE, align=PP_ALIGN.LEFT):
    tf = shape.text_frame
    tf.word_wrap = True
    tf.margin_left = Inches(0.1)
    tf.margin_right = Inches(0.1)
    tf.margin_top = Inches(0.08)
    tf.margin_bottom = Inches(0.08)
    try:
        tf.vertical_anchor = MSO_ANCHOR.TOP
    except Exception:
        pass
    write_tf(
        tf,
        [
            (title, title_size, True, title_c, FONT),
            (body, body_size, False, body_c, FONT),
        ],
        align=align,
        spacing=1.05,
    )


def pic(slide, path: Path, l, t, w, h):
    return slide.shapes.add_picture(str(path), l, t, w, h)


def header(slide, title: str, mark: Path, sih_icon: Path) -> None:
    pic(slide, mark, px(48), px(26), px(70), px(70))
    add_tb(slide, px(128), px(28), px(420), px(36), "TESSERACT", 18, True, NAVY)
    add_tb(slide, px(128), px(62), px(520), px(28), "LOCAL PRIVACY.  REMOTE REASONING.", 10, True, ORANGE)
    add_tb(slide, px(520), px(32), px(880), px(48), title, 24, True, DARK, align=PP_ALIGN.CENTER)
    pic(slide, sih_icon, px(1588), px(16), px(72), px(88))
    add_tb(slide, px(1664), px(16), px(230), px(88), "SMART INDIA\nHACKATHON\n2026", 11, True, NAVY, align=PP_ALIGN.LEFT)
    line = add_rect(slide, px(48), px(112), px(1824), px(2), LINE)


def tick_cell(cell, yes: bool) -> None:
    cell.text = ""
    p = cell.text_frame.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    _set_run(run, "✓" if yes else "✗", 18, True, GREEN if yes else RED, FONT_SYM)
    cell.vertical_anchor = MSO_ANCHOR.MIDDLE
    fill = OFFWHITE
    cell.fill.solid()
    cell.fill.fore_color.rgb = WHITE


def set_cell(cell, text: str, size: float, bold: bool, color: RGBColor, fill: RGBColor, align=PP_ALIGN.LEFT, font: str = FONT) -> None:
    cell.fill.solid()
    cell.fill.fore_color.rgb = fill
    cell.text = text
    tf = cell.text_frame
    tf.word_wrap = True
    tf.margin_left = Inches(0.06)
    tf.margin_right = Inches(0.06)
    p = tf.paragraphs[0]
    p.alignment = align
    if p.runs:
        _set_run(p.runs[0], text, size, bold, color, font)
    try:
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
    except Exception:
        pass


def slide_1(prs, blank, mark, sih_icon):
    s = prs.slides.add_slide(blank)
    add_tb(s, px(200), px(40), px(1520), px(56), "SMART INDIA HACKATHON 2026", 32, True, NAVY, PP_ALIGN.CENTER, FONT_SERIF)
    add_tb(s, px(200), px(96), px(1520), px(40), "TITLE PAGE", 20, True, DARK, PP_ALIGN.CENTER, FONT_SERIF)
    pic(s, sih_icon, px(1588), px(24), px(72), px(90))
    add_tb(s, px(1664), px(28), px(230), px(90), "SMART INDIA\nHACKATHON\n2026", 11, True, NAVY)

    rows = [
        ("Problem Statement ID  —  ", "26171", GREEN_DK),
        ("Problem Statement Title  —  ", "On-device Visual Perception for Light-weight Browser Agents", ORANGE_DK),
        ("Organisation  —  ", "Indian Space Research Organisation (ISRO)", DARK),
        ("Theme  —  ", "Smart Automation", DARK),
        ("PS Category  —  ", "Software", DARK),
        ("Team ID  —  ", "—", DARK),
        ("Team Name  :  ", "Tesseract BTW", NAVY),
    ]
    y = 210
    for label, value, color in rows:
        add_tb(s, px(70), px(y), px(36), px(40), "•", 20, True, NAVY)
        h = 96 if "Title" in label else 52
        add_runs(
            s,
            px(110),
            px(y),
            px(1100),
            px(h),
            [
                (label, 18, True, DARK, FONT),
                (value, 18, True, color, FONT),
            ],
            anchor=MSO_ANCHOR.TOP,
        )
        y += h + 8

    add_tb(s, px(110), px(760), px(1100), px(36), "Privacy-Preserving Browser Agent", 18, True, NAVY)
    add_tb(
        s,
        px(110),
        px(800),
        px(1100),
        px(70),
        "A local privacy proxy between the webpage and the reasoning model — on-device perception, redaction before the network, constrained actions after.",
        13,
        False,
        MUTED,
    )
    pic(s, sih_icon, px(1320), px(200), px(520), px(640))
    bar = add_box(s, px(86), px(980), px(1100), px(56), NAVY, radius=0.3)
    write_tf(
        bar.text_frame,
        [("Chrome extension  ·  On-device redaction  ·  Constrained browser agent", 13, True, WHITE, FONT)],
        align=PP_ALIGN.CENTER,
        anchor=MSO_ANCHOR.MIDDLE,
    )


def slide_2(prs, blank, mark, sih_icon):
    s = prs.slides.add_slide(blank)
    header(s, "PROPOSED SOLUTION", mark, sih_icon)

    features = [
        ("1. Local Visual Perception", "On-device YuNet face detection plus DOM-first screen reading. The raw screenshot never leaves the machine."),
        ("2. Layered PII Detection", "Field purpose, checksum validators for Aadhaar / PAN / GSTIN / cards, then English NER only where regex fails."),
        ("3. Privacy-Preserving Filter", "Typed placeholders, padded black-box masks, one-way password / OTP / CVV tokens. Vault stays in the tab."),
        ("4. Constrained Browser Agent", "Closed action vocabulary, current element ids, user approval for submit / purchase. No model-written JavaScript."),
        ("5. Sanitized Server Planning", "Only anonymized context reaches the LLM. The server returns click, type and scroll — never secrets."),
    ]
    y = 128
    for title, body in features:
        shp = add_box(s, px(40), px(y), px(520), px(160), GREEN_SOFT, GREEN_BORDER, 0.08)
        shape_copy(shp, title, body, 13, 11, NAVY, MUTED)
        y += 174

    # Reality photo + captions
    pic(s, ASSETS / "problem-reality.png", px(584), px(128), px(884), px(300))
    cap = add_rect(s, px(584), px(128), px(884), px(70), NAVY_DEEP)
    write_tf(
        cap.text_frame,
        [
            ("THE REALITY TODAY", 12, True, ORANGE, FONT),
            ("Cloud agents see Aadhaar, PAN, faces, passwords and bank fields on the live screen.", 11, False, WHITE, FONT),
        ],
        anchor=MSO_ANCHOR.MIDDLE,
    )
    foot = add_rect(s, px(584), px(428), px(884), px(42), NAVY_DEEP)
    write_tf(foot.text_frame, [("RAW SCREEN  ·  RAW PII  ·  RAW TRUST GAP", 11, True, WHITE, FONT)], PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)

    ben = add_rect(s, px(584), px(486), px(884), px(58), NAVY)
    write_tf(
        ben.text_frame,
        [("BENEFITS     ✓ PII stays local     ✓ Checksum IDs     ✓ Face masks     ✓ Closed actions     ✓ DPDP-aligned", 11, True, WHITE, FONT)],
        PP_ALIGN.LEFT,
        MSO_ANCHOR.MIDDLE,
    )
    # make checkmarks use symbol font via a cleaner benefits row
    ben.text_frame.clear()
    p = ben.text_frame.paragraphs[0]
    p.alignment = PP_ALIGN.LEFT
    _set_run(p.add_run(), "  BENEFITS   ", 11, True, WHITE, FONT)
    for label in ("PII stays local", "Checksum IDs", "Face masks", "Closed actions", "DPDP-aligned"):
        _set_run(p.add_run(), "  ✓  ", 12, True, GREEN_SOFT, FONT_SYM)
        _set_run(p.add_run(), label + "   ", 11, True, WHITE, FONT)

    mocks = [
        (ASSETS / "ui-analyze.png", "ANALYZE PAGE"),
        (ASSETS / "ui-sanitized.png", "SANITIZED SCREEN"),
        (ASSETS / "ui-actions.png", "VALIDATED ACTIONS"),
    ]
    x = 584
    for path, cap_t in mocks:
        pic(s, path, px(x), px(560), px(280), px(390))
        lab = add_rect(s, px(x), px(950), px(280), px(44), NAVY)
        write_tf(lab.text_frame, [(cap_t, 11, True, WHITE, FONT)], PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
        x += 298

    col = add_box(s, px(1500), px(128), px(380), px(916), RED_DK, radius=0.06)
    write_tf(col.text_frame, [("CURRENT CHALLENGES", 16, True, WHITE, FONT)], PP_ALIGN.CENTER, MSO_ANCHOR.TOP)
    challenges = [
        ("01  Raw screenshots", "Cloud GUI agents upload the live screen, secrets included."),
        ("02  Indian identifiers", "Aadhaar, PAN, GSTIN and UPI sit in ordinary page text."),
        ("03  Faces & documents", "Portraits and ID photos leak through pixel pipelines."),
        ("04  Unconstrained actions", "A model that can run JS can exfiltrate or destroy data."),
        ("05  Browser budget", "A full VLM will not fit; latency and RAM are real limits."),
        ("06  Trust gap", "Users will not adopt agents that treat PII as context."),
    ]
    cy = 200
    for title, body in challenges:
        card = add_box(s, px(1520), px(cy), px(340), px(118), RED_CARD, radius=0.1)
        shape_copy(card, title, body, 12, 11, WHITE, RGBColor(255, 224, 224))
        cy += 128


def slide_3(prs, blank, mark, sih_icon):
    s = prs.slides.add_slide(blank)
    header(s, "Technical Approach", mark, sih_icon)
    add_tb(s, px(48), px(124), px(700), px(32), "SYSTEM WORKFLOW", 14, True, NAVY)

    steps = [
        "1. User starts Analyze or Run agent from the popup.",
        "2. Service worker injects the content script on demand — never on every page load.",
        "3. Visible DOM is extracted with stable element_N ids.",
        "4. Rules + checksums redact PII. The vault is minted inside the tab.",
        "5. Offscreen WASM runs YuNet, DistilBERT NER and selective OCR.",
        "6. Screenshot sanitizer paints padded black masks for secrets and faces.",
        "7. Privacy gateway rejects unsanitized or leaking payloads.",
        "8. LLM returns a closed action list. The extension validates, confirms and applies locally.",
    ]
    y = 160
    for i, body in enumerate(steps):
        n = add_oval(s, px(56), px(y + 8), px(36), px(36), GREEN)
        write_tf(n.text_frame, [(str(i + 1), 12, True, WHITE, FONT)], PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
        box = add_box(s, px(108), px(y), px(640), px(68), OFFWHITE, LINE, 0.12)
        write_tf(box.text_frame, [(body, 12, False, DARK, FONT)], anchor=MSO_ANCHOR.MIDDLE)
        y += 76

    stack = add_box(s, px(48), px(780), px(700), px(260), NAVY, radius=0.08)
    write_tf(
        stack.text_frame,
        [
            ("TECH STACK", 14, True, WHITE, FONT),
            ("Chrome MV3   ·   Vanilla JS   ·   ONNX Runtime Web   ·   OpenCV YuNet 232 KB", 12, False, WHITE, FONT),
            ("DistilBERT NER q8   ·   Tesseract.js   ·   Express gateway   ·   OpenAI-compatible LLM", 12, False, WHITE, FONT),
            ("Mock provider   ·   Playwright E2E", 12, False, WHITE, FONT),
        ],
        anchor=MSO_ANCHOR.MIDDLE,
        spacing=1.15,
    )

    add_tb(s, px(780), px(124), px(1080), px(32), "SMART WORKFLOW OF THE AGENT", 14, True, NAVY)
    arch = [
        (780, 164, 340, 100, NAVY, "USER CHANNEL", "Chrome popup · consent · policy toggles · sanitized preview"),
        (1140, 164, 340, 100, BLUE_MID, "ORCHESTRATOR", "MV3 service worker · inject · capture · agent loop"),
        (1500, 164, 380, 100, GREEN_DK, "PAGE CONTEXT", "Isolated content script · DOM · vault · apply"),
        (780, 284, 460, 120, PURPLE_DK, "OFFSCREEN MODELS", "YuNet faces · DistilBERT names · Tesseract OCR · WASM / ONNX"),
        (1260, 284, 620, 120, RED_DK, "TRUST BOUNDARY", "Vault never leaves the tab. Passwords / OTP / CVV are one-way tokens. Raw PNG never accepted on the wire."),
        (780, 424, 520, 120, TEAL, "PRIVACY GATEWAY  :4317", "Structural validation · leak scan · branded JPEG · mock or OpenAI-compatible planner"),
        (1320, 424, 560, 120, ORANGE_DK, "PLANNER", "Closed JSON actions only: click, type, fill_from_vault, scroll, wait, done"),
        (780, 564, 1100, 130, FOREST, "LOCAL EXECUTION", "Validate ids twice · refuse credential fills · confirm submit/purchase · expand placeholders only inside the isolated world · re-extract each turn (max 6 / 90s)"),
    ]
    for x, y, w, h, fill, title, body in arch:
        shp = add_box(s, px(x), px(y), px(w), px(h), fill, radius=0.08)
        shape_copy(shp, title, body, 12, 11, WHITE, RGBColor(240, 244, 248))

    why = add_box(s, px(780), px(714), px(1100), px(326), OFFWHITE, LINE, 0.06)
    write_tf(
        why.text_frame,
        [
            ("WHY THIS SHAPE EXISTS", 14, True, NAVY, FONT),
            ("Popup cannot read a tab. Service worker cannot host long WASM. Only the content script can keep a vault next to the live DOM.", 13, False, MUTED, FONT),
            ("Models are used only where checksums and DOM facts are not enough: names, faces, painted text.", 13, False, MUTED, FONT),
            ("The remote model proposes intent. Deterministic code owns authority, ids, and secret expansion.", 13, False, MUTED, FONT),
        ],
        spacing=1.12,
    )


def slide_4(prs, blank, mark, sih_icon):
    s = prs.slides.add_slide(blank)
    header(s, "Feasibility & Viability", mark, sih_icon)
    cards = [
        (PURPLE, "1. Analysing the feasibility of the idea",
         "• Easy to implement: Chrome MV3, WASM and ONNX Runtime Web — no native app, no new hardware.\n"
         "• Lightweight: YuNet is ~232 KB and packaged locally; DistilBERT q8 loads once and is cached.\n"
         "• Measured: 16-page rule corpus, 100% precision, 90.2% F1. Safety, server and E2E suites are separate.\n"
         "• Demo-ready: mock planner runs fully offline; cloud LLM is a config switch, not an architecture change."),
        (MINT, "Potential Challenges & Risks",
         "• Indic names in prose: English DistilBERT recall does not cover Devanagari person names.\n"
         "• No labelled pixel corpus yet: YuNet/OCR run in E2E tests, but face IoU / over-redaction are not scored.\n"
         "• Hybrid-mode gap: local vision can run without those detections reaching the planner.\n"
         "• Detection defines coverage: novel IDs and some bank-account shapes can still slip through."),
        (SKY, "2. Strategies for overcoming these challenges",
         "• Strongest-first evidence: Verhoeff / Luhn / GSTIN checksums before any model confidence score.\n"
         "• Lazy, offscreen inference so the service worker stays event-driven and the UI does not freeze.\n"
         "• Dual gates: extension and server both reject raw fields, vault values and unknown actions.\n"
         "• Separate eval families: rule F1, safety suite, server tests, and real-browser E2E — never mixed."),
        (PEACH, "Evaluation of Long-Term Sustainability",
         "• Scalable: a Chrome/Edge extension can move from one machine → campus → department → nationwide.\n"
         "• Policy fit: local minimisation matches DPDP 2023 and the ISRO brief to send only non-sensitive structure.\n"
         "• Improving data: more pages and a labelled pixel set raise recall without enlarging the trust boundary.\n"
         "• Adaptable: swap the planner (mock, Ollama, OpenRouter) without touching redaction or the vault."),
    ]
    positions = [(48, 132), (984, 132), (48, 600), (984, 600)]
    for (x, y), (bg, title, body) in zip(positions, cards):
        shp = add_box(s, px(x), px(y), px(888), px(440), bg, radius=0.06)
        tf = shp.text_frame
        tf.word_wrap = True
        tf.margin_left = Inches(0.16)
        tf.margin_right = Inches(0.16)
        tf.margin_top = Inches(0.14)
        tf.margin_bottom = Inches(0.12)
        write_tf(tf, [(title, 16, True, NAVY, FONT), (body, 13, False, DARK, FONT)], spacing=1.12)


def slide_5(prs, blank, mark, sih_icon):
    s = prs.slides.add_slide(blank)
    header(s, "Impacts and Benefits", mark, sih_icon)
    add_tb(s, px(48), px(124), px(700), px(32), "Impact Created on Society", 16, True, NAVY)

    impacts = [
        (80, 280, "Our Social Impact", "Citizens can use agents on DigiLocker, banks and government portals without handing over Aadhaar, PAN or passwords."),
        (430, 280, "Digital Transformation", "Turns the agentic web from “upload the screen” into a privacy proxy: local evidence, remote reasoning, local action."),
        (80, 680, "Environmental Impact", "On-device WASM inference and a 232 KB face model avoid shipping every screenshot to a GPU cluster."),
        (430, 680, "Government Impact", "Fits ISRO’s brief: only non-sensitive structure leaves the client. Path from one workstation → organisation → national scale."),
    ]
    for x, y, title, body in impacts:
        lab = add_box(s, px(x + 20), px(y - 36), px(260), px(36), PINK, radius=0.4)
        write_tf(lab.text_frame, [(title, 11, True, RED_DK, FONT)], PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
        circ = add_oval(s, px(x), px(y), px(300), px(300), WHITE, GREEN, 2.25)
        write_tf(circ.text_frame, [(body, 12, False, DARK, FONT)], PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)

    pic(s, ASSETS / "citizen-circle.png", px(1180), px(430), px(280), px(280))
    benefits = [
        (800, 160, "No raw PII to the cloud", "Redacted DOM + masked JPEG only."),
        (1160, 160, "Saves user trust", "Secrets stay in the tab-local vault."),
        (1520, 160, "Indian ID intelligence", "Verhoeff, Luhn, GSTIN, PAN, IFSC."),
        (800, 860, "Faces blacked out", "YuNet boxes become padded masks."),
        (1160, 860, "Safe agency", "Closed vocabulary, confirmations, 6-turn cap."),
        (1520, 860, "Scalable extension", "Chrome/Edge today; same privacy contract later."),
    ]
    for x, y, title, body in benefits:
        shp = add_box(s, px(x), px(y), px(340), px(118), ICE, NAVY, 0.12)
        shape_copy(shp, title, body, 13, 12, NAVY, MUTED)


def slide_6(prs, blank, mark, sih_icon):
    s = prs.slides.add_slide(blank)
    header(s, "Research & References", mark, sih_icon)

    nodes = [
        (250, 170, "CHOOSING PROBLEM STATEMENT"),
        (470, 310, "ANALYSIS OF EXISTING AGENTS"),
        (250, 450, "DESIGN LAYERED PRIVACY STACK"),
        (40, 310, "EVAL, SAFETY GATES, DEMO"),
    ]
    center = add_oval(s, px(268), px(292), px(156), px(156), WHITE, NAVY, 2.0)
    write_tf(center.text_frame, [("Research Workflow", 11, True, NAVY, FONT)], PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
    for x, y, label in nodes:
        n = add_box(s, px(x), px(y), px(220), px(56), NAVY, radius=0.4)
        write_tf(n.text_frame, [(label, 10, True, WHITE, FONT)], PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)

    refs_box = add_box(s, px(40), px(540), px(680), px(500), NAVY, radius=0.06)
    refs = [
        "SIH26171  |  ISRO  |  DPDP 2023  |  MV3",
        "1. SIH 2026 PS SIH26171 — On-device Visual Perception for Light-weight Browser Agents (ISRO / Department of Space).",
        "2. ONNX Runtime Web + OpenCV YuNet 2023mar — compact on-device face detection.",
        "3. Hugging Face Transformers.js / DistilBERT NER (q8) — English names after rule redaction.",
        "4. Tesseract.js — selective OCR for image, canvas and video text.",
        "5. Digital Personal Data Protection Act, 2023 — purpose limitation and minimisation.",
        "6. Chrome Manifest V3 + Offscreen Documents — event-driven privacy architecture.",
        "7. UIDAI Verhoeff checksum, Luhn (cards), GSTIN mod-36 — exact Indian identifier tests.",
        "8. Minim / MaskClaw (2026) — edge-side sanitization for GUI agents before cloud reasoning.",
    ]
    lines = [(refs[0], 12, True, ORANGE, FONT)]
    lines += [(r, 11, False, WHITE, FONT) for r in refs[1:]]
    tf = refs_box.text_frame
    tf.word_wrap = True
    tf.margin_left = Inches(0.14)
    tf.margin_right = Inches(0.12)
    tf.margin_top = Inches(0.12)
    write_tf(tf, lines, spacing=1.08)

    add_tb(s, px(740), px(124), px(1140), px(32), "COMPARISON WITH EXISTING APPROACHES", 14, True, NAVY)

    headers = ["FEATURES", "Cloud GUI agents", "Browser copilots", "Password managers", "TESSERACT"]
    head_fill = [NAVY, GREEN_DK, PURPLE_DK, ORANGE_DK, NAVY_DEEP]
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
    rows, cols = 10, 5
    table_shape = s.shapes.add_table(rows, cols, px(740), px(168), px(1120), px(800))
    table = table_shape.table
    widths = [Inches(2.55), Inches(1.30), Inches(1.30), Inches(1.35), Inches(1.28)]
    for i, w in enumerate(widths):
        table.columns[i].width = w

    for c, (label, fill) in enumerate(zip(headers, head_fill)):
        set_cell(table.cell(0, c), label, 11, True, WHITE, fill, PP_ALIGN.CENTER)

    for r, feat in enumerate(features):
        bg = OFFWHITE if r % 2 == 0 else WHITE
        set_cell(table.cell(r + 1, 0), feat, 11, True, DARK, bg, PP_ALIGN.LEFT)
        for c, val in enumerate(matrix[r]):
            cell = table.cell(r + 1, c + 1)
            cell.fill.solid()
            cell.fill.fore_color.rgb = bg
            cell.text = "✓" if val else "✗"
            p = cell.text_frame.paragraphs[0]
            p.alignment = PP_ALIGN.CENTER
            if p.runs:
                _set_run(p.runs[0], p.runs[0].text, 16, True, GREEN if val else RED, FONT_SYM)
            try:
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            except Exception:
                pass

    add_tb(
        s,
        px(740),
        px(1000),
        px(1130),
        px(40),
        "Tesseract is the only column that combines on-device perception, Indian identifier intelligence, and a constrained agent.",
        11,
        False,
        MUTED,
    )


def main() -> None:
    mark = trim_white(ASSETS / "tesseract-logo.png", ASSETS / "tesseract-mark.png")
    circle_mask(ASSETS / "citizen.png", ASSETS / "citizen-circle.png")
    sih_icon = ASSETS / "sih-icon-clean.png"

    prs = Presentation()
    prs.slide_width = Inches(SW)
    prs.slide_height = Inches(SH)
    blank = prs.slide_layouts[6]

    slide_1(prs, blank, mark, sih_icon)
    slide_2(prs, blank, mark, sih_icon)
    slide_3(prs, blank, mark, sih_icon)
    slide_4(prs, blank, mark, sih_icon)
    slide_5(prs, blank, mark, sih_icon)
    slide_6(prs, blank, mark, sih_icon)

    # Give slides names in the outline
    titles = [
        "Title Page",
        "Proposed Solution",
        "Technical Approach",
        "Feasibility & Viability",
        "Impacts and Benefits",
        "Research & References",
    ]
    for slide, name in zip(prs.slides, titles):
        notes = slide.notes_slide.notes_text_frame
        notes.text = f"Tesseract BTW — {name}. All text boxes, cards and table cells are editable."

    prs.save(OUT)
    print("wrote", OUT)
    try:
        prs.save(DESKTOP)
        print("desktop", DESKTOP)
    except PermissionError:
        alt = Path.home() / "Desktop" / "Tesseract_BTW_SIH2026_EDITABLE.pptx"
        prs.save(alt)
        print("desktop was locked; saved", alt)


if __name__ == "__main__":
    main()
