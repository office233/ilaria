"""Builds docs/funding/Ilaria-Swypik-pitch-deck.pdf (landscape slides) with reportlab.

Only verified facts from the repository README / proposal; no invented traction.
"""
import os

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import landscape, A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Ilaria-Swypik-pitch-deck.pdf")
W, H = landscape(A4)
INK, MUTED, ACCENT, BG = HexColor("#111827"), HexColor("#4B5563"), HexColor("#1D4ED8"), HexColor("#F8FAFC")

# Arial covers Romanian diacritics; fall back to Helvetica if missing.
try:
    pdfmetrics.registerFont(TTFont("Body", r"C:\Windows\Fonts\arial.ttf"))
    pdfmetrics.registerFont(TTFont("Bold", r"C:\Windows\Fonts\arialbd.ttf"))
    BODY, BOLD = "Body", "Bold"
except Exception:
    BODY, BOLD = "Helvetica", "Helvetica-Bold"

SLIDES = [
    ("Ilaria", "An open Romanian-first language model with one-shot memory — powering Swypik",
     ["THERAPIUM GROUP SRL · Romania · founded 2025",
      "Abel Varga, Founder & CEO · abel@swypik.com",
      "Code: github.com/office233/ilaria · Product: swypik.com"]),
    ("Problem", None,
     ["Romanian is a minor share of the training data of today's open models (Llama, Qwen, Gemma).",
      "Frozen LLMs cannot learn a new fact without retraining — but products, prices and policies change daily.",
      "Romanian and CEE SMEs lack affordable AI that speaks their language and stays up to date."]),
    ("Solution: Ilaria", None,
     ["Bilingual Romanian–English decoder trained from scratch (RoPE, SwiGLU, 32k byte-level BPE).",
      "Own Go inference engine, numerically identical to PyTorch (max |Δlogit| 2e-5).",
      "Hippocampus-inspired episodic memory: learns a fact from ONE exposure, no gradient update,",
      "and keeps it after restart."]),
    ("Traction so far (measured)", None,
     ["Ilaria-130M trained on 3.0B tokens (FineWeb-2 Romanian, FineWeb-Edu, Wikipedia) in ~4 h on one GPU.",
      "Held-out perplexity on 2025 Wikipedia: 24.4 overall — Romanian 20.8, English 28.7.",
      "One-shot continual-learning benchmark: 89% strict accuracy vs 1% for the same frozen model;",
      "100% recall after restart. Open source (AGPL-3.0)."]),
    ("Product: Swypik", None,
     ["Video-native social commerce for Romania and Central-Eastern Europe (swypik.com), plus a Romanian ERP.",
      "Ilaria's jobs inside Swypik: content moderation, Romanian shopping assistant,",
      "captions and translation, product-quality scoring.",
      "One-shot memory = new products and prices are known instantly, without retraining."]),
    ("Market", None,
     ["~24M Romanian speakers, plus CEE e-commerce and SMEs needing local-language AI.",
      "Beachhead: our own platform (Swypik) → then Romanian SMEs via API and the ERP.",
      "Open models + low-cost inference (small model, Go engine) keep serving costs low."]),
    ("Why we win", None,
     ["Romanian-first data and tokenizer (1.67 tokens/word in Romanian vs 3.11 for our previous tokenizer).",
      "Continual learning without retraining — a capability frozen LLMs structurally lack.",
      "Full stack in-house: data pipeline, trainer, inference engine, memory, product."]),
    ("NVIDIA technology", None,
     ["Training: PyTorch + CUDA (bf16, torch.compile) on NVIDIA data-centre GPUs.",
      "Inference: our Go engine calls cuBLAS on NVIDIA GPUs.",
      "Next: EuroHPC application for H100 time on MareNostrum 5 (1B → 3B → 7B);",
      "serving with TensorRT-LLM / NIM."]),
    ("Roadmap", None,
     ["Q4 2026: Ilaria-1B and 3B (gated scaling ladder), instruction tuning for Romanian assistant tasks.",
      "Q1 2027: Ilaria-7B on up to 300B tokens; open release of weights, tokenizer, benchmark.",
      "2027: Ilaria in production across Swypik; API for Romanian SMEs."]),
    ("Team & ask", None,
     ["Abel Varga — Founder & CEO, builds the full stack (models, engine, platform).",
      "Oana Cioacata — CFO.",
      "Ask: GPU compute and cloud credits to train and serve Ilaria at scale;",
      "NVIDIA Inception support for training, inference optimisation and go-to-market."]),
]


def slide(c, n, title, subtitle, bullets):
    c.setFillColor(BG)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    c.setFillColor(ACCENT)
    c.rect(0, H - 8, W, 8, stroke=0, fill=1)
    c.setFillColor(INK)
    c.setFont(BOLD, 34 if n == 1 else 28)
    c.drawString(56, H - 100, title)
    y = H - 140
    if subtitle:
        c.setFont(BODY, 18)
        c.setFillColor(MUTED)
        c.drawString(56, y, subtitle)
        y -= 50
    c.setFillColor(INK)
    for b in bullets:
        text = ("• " if n > 1 else "") + b
        size = 16
        while pdfmetrics.stringWidth(text, BODY, size) > W - 100 and size > 10:
            size -= 0.5  # shrink long lines so nothing runs off the slide
        c.setFont(BODY, size)
        c.drawString(56, y, text)
        y -= 34
    c.setFont(BODY, 10)
    c.setFillColor(MUTED)
    c.drawRightString(W - 40, 24, f"Ilaria · Swypik · {n}/{len(SLIDES)}")
    c.showPage()


def main():
    c = canvas.Canvas(OUT, pagesize=(W, H))
    c.setTitle("Ilaria / Swypik — pitch deck")
    for i, (t, s, b) in enumerate(SLIDES, 1):
        slide(c, i, t, s, b)
    c.save()
    print(OUT)


if __name__ == "__main__":
    main()
