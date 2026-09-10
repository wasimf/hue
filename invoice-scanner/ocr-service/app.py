"""PaddleOCR sidecar for the Node invoice-scanner.

The Node application owns the whole pipeline; this service does one thing:
turn a single page (image or one-page PDF) into positioned, scored text lines.

Contract
--------
GET  /health -> {"status": "ok", "engine": ..., "languages": [...], "models_loaded": bool}
POST /ocr    -> multipart form:
                  file      (required) image/* or application/pdf
                  languages (optional) comma separated PaddleOCR language codes
                  dpi       (optional) rasterisation DPI for PDF input
             <- {"engine": ..., "languages": [...], "pages": [
                   {"page_number": 1, "width": w, "height": h,
                    "lines": [{"text": ..., "confidence": 0..1,
                               "box": {"x0":..,"y0":..,"x1":..,"y1":..}}],
                    "warnings": [...]}]}

Boxes are axis-aligned rectangles in page pixel coordinates with the origin at
the top-left, which is what the Node layout model expects.
"""

from __future__ import annotations

import io
import logging
import os
import threading
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

try:  # Optional at import time so /health can explain what is missing.
    import fitz  # PyMuPDF
except ImportError:  # pragma: no cover - exercised only in broken installs
    fitz = None  # type: ignore[assignment]

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None  # type: ignore[assignment]

try:
    from paddleocr import PaddleOCR
except ImportError:  # pragma: no cover
    PaddleOCR = None  # type: ignore[assignment]


logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("ocr-service")

DEFAULT_LANGUAGES = [
    lang.strip() for lang in os.getenv("PADDLE_LANGS", "en").split(",") if lang.strip()
]
USE_GPU = os.getenv("PADDLE_USE_GPU", "false").lower() in {"1", "true", "yes"}
USE_ANGLE_CLS = os.getenv("PADDLE_USE_ANGLE_CLS", "true").lower() in {"1", "true", "yes"}
# Invoice-tuned detector defaults: invoices have dense, small, tabular text, so
# a lower box threshold and a slightly larger unclip ratio recover thin rows.
DET_DB_BOX_THRESH = float(os.getenv("PADDLE_DET_DB_BOX_THRESH", "0.5"))
DET_DB_THRESH = float(os.getenv("PADDLE_DET_DB_THRESH", "0.3"))
DET_DB_UNCLIP_RATIO = float(os.getenv("PADDLE_DET_DB_UNCLIP_RATIO", "1.8"))
DET_LIMIT_SIDE_LEN = int(os.getenv("PADDLE_DET_LIMIT_SIDE_LEN", "1920"))
DROP_SCORE = float(os.getenv("PADDLE_DROP_SCORE", "0.35"))
MAX_PDF_DPI = int(os.getenv("PADDLE_MAX_DPI", "400"))
# Load the models during startup instead of on the first request. The container
# then only reports healthy once it can actually serve, which is what lets
# docker compose hold the app back until OCR is genuinely ready.
PRELOAD = os.getenv("PADDLE_PRELOAD", "false").lower() in {"1", "true", "yes"}

app = FastAPI(title="invoice-scanner PaddleOCR service", version="1.0.0")

_engines: dict[str, Any] = {}
_engine_lock = threading.Lock()


def _build_engine(language: str) -> Any:
    """Creates (and caches) one PaddleOCR instance per language."""
    if PaddleOCR is None:
        raise HTTPException(status_code=503, detail="paddleocr is not installed in this environment")

    kwargs: dict[str, Any] = {
        "lang": language,
        "use_angle_cls": USE_ANGLE_CLS,
        "show_log": False,
        "det_db_thresh": DET_DB_THRESH,
        "det_db_box_thresh": DET_DB_BOX_THRESH,
        "det_db_unclip_ratio": DET_DB_UNCLIP_RATIO,
        "det_limit_side_len": DET_LIMIT_SIDE_LEN,
        "drop_score": DROP_SCORE,
        "use_gpu": USE_GPU,
    }

    # PaddleOCR 3.x removed several 2.x constructor arguments. Retry without the
    # ones it rejects instead of pinning the caller to one major version.
    while True:
        try:
            return PaddleOCR(**kwargs)
        except (TypeError, ValueError) as error:
            message = str(error)
            removed = [key for key in list(kwargs) if key != "lang" and key in message]
            if not removed:
                raise
            for key in removed:
                kwargs.pop(key, None)
            logger.warning("dropping unsupported PaddleOCR options %s", removed)


def get_engine(language: str) -> Any:
    with _engine_lock:
        if language not in _engines:
            logger.info("loading PaddleOCR model for language=%s", language)
            _engines[language] = _build_engine(language)
        return _engines[language]


@dataclass
class Line:
    text: str
    confidence: float
    x0: float
    y0: float
    x1: float
    y1: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "confidence": round(float(self.confidence), 4),
            "box": {
                "x0": round(float(self.x0), 2),
                "y0": round(float(self.y0), 2),
                "x1": round(float(self.x1), 2),
                "y1": round(float(self.y1), 2),
            },
        }


@dataclass
class Page:
    page_number: int
    width: int
    height: int
    lines: list[Line] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "page_number": self.page_number,
            "width": self.width,
            "height": self.height,
            "lines": [line.as_dict() for line in self.lines],
            "warnings": self.warnings,
        }


def _quad_to_rect(quad: Sequence[Sequence[float]]) -> tuple[float, float, float, float]:
    xs = [float(point[0]) for point in quad]
    ys = [float(point[1]) for point in quad]
    return min(xs), min(ys), max(xs), max(ys)


def _normalise_result(raw: Any) -> list[Line]:
    """Accepts both the 2.x list format and the 3.x dict format."""
    lines: list[Line] = []
    if not raw:
        return lines

    # PaddleOCR 3.x: [{"rec_texts": [...], "rec_scores": [...], "dt_polys": [...]}]
    first = raw[0] if isinstance(raw, (list, tuple)) and raw else None
    if isinstance(first, dict):
        texts = first.get("rec_texts") or []
        scores = first.get("rec_scores") or []
        polys = first.get("dt_polys") or first.get("rec_polys") or []
        for index, text in enumerate(texts):
            if not text:
                continue
            poly = polys[index] if index < len(polys) else [[0, 0], [0, 0], [0, 0], [0, 0]]
            x0, y0, x1, y1 = _quad_to_rect(poly)
            score = float(scores[index]) if index < len(scores) else 0.0
            lines.append(Line(text=str(text), confidence=score, x0=x0, y0=y0, x1=x1, y1=y1))
        return lines

    # PaddleOCR 2.x: [[[quad, (text, score)], ...]]
    page = raw[0] if isinstance(first, (list, tuple)) else raw
    for entry in page or []:
        try:
            quad, (text, score) = entry[0], entry[1]
        except (TypeError, ValueError, IndexError):
            continue
        if not text:
            continue
        x0, y0, x1, y1 = _quad_to_rect(quad)
        lines.append(Line(text=str(text), confidence=float(score), x0=x0, y0=y0, x1=x1, y1=y1))
    return lines


def _run_engine(image: "np.ndarray", language: str) -> list[Line]:
    engine = get_engine(language)
    try:
        if hasattr(engine, "ocr"):
            try:
                raw = engine.ocr(image, cls=USE_ANGLE_CLS)
            except TypeError:
                raw = engine.ocr(image)
        else:  # PaddleOCR 3.x renamed the entry point
            raw = engine.predict(image)
    except Exception as error:  # pragma: no cover - engine level failure
        logger.exception("PaddleOCR failed for language=%s", language)
        raise HTTPException(status_code=500, detail=f"OCR failed: {error}") from error
    return _normalise_result(raw)


def _iou(a: Line, b: Line) -> float:
    inter_x = max(0.0, min(a.x1, b.x1) - max(a.x0, b.x0))
    inter_y = max(0.0, min(a.y1, b.y1) - max(a.y0, b.y0))
    intersection = inter_x * inter_y
    if intersection <= 0:
        return 0.0
    area_a = max(1e-6, (a.x1 - a.x0) * (a.y1 - a.y0))
    area_b = max(1e-6, (b.x1 - b.x0) * (b.y1 - b.y0))
    return intersection / (area_a + area_b - intersection)


def _merge(primary: list[Line], secondary: Iterable[Line]) -> list[Line]:
    """Adds lines from a secondary language pass that the primary pass missed.

    Overlapping detections are resolved by confidence, which is what makes a
    mixed Hebrew/English invoice readable with two single-language models.
    """
    merged = list(primary)
    for candidate in secondary:
        overlap_index = next((index for index, line in enumerate(merged) if _iou(line, candidate) > 0.5), None)
        if overlap_index is None:
            merged.append(candidate)
        elif candidate.confidence > merged[overlap_index].confidence + 0.05:
            merged[overlap_index] = candidate
    return merged


def _image_to_array(data: bytes) -> "np.ndarray":
    if Image is None:
        raise HTTPException(status_code=503, detail="Pillow is not installed in this environment")
    image = Image.open(io.BytesIO(data))
    image = image.convert("RGB")
    return np.array(image)


def _pdf_to_arrays(data: bytes, dpi: int) -> list["np.ndarray"]:
    if fitz is None:
        raise HTTPException(status_code=503, detail="PyMuPDF is not installed in this environment")
    zoom = min(dpi, MAX_PDF_DPI) / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    arrays: list[np.ndarray] = []
    with fitz.open(stream=data, filetype="pdf") as document:
        for page in document:
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            array = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width, pixmap.n)
            arrays.append(array[:, :, :3])
    return arrays


@app.on_event("startup")
def preload_models() -> None:
    if not PRELOAD:
        return
    for language in DEFAULT_LANGUAGES:
        try:
            get_engine(language)
        except Exception:  # noqa: BLE001 - never let a warm-up failure kill the service
            logger.warning("could not preload the model for language=%s", language, exc_info=True)


@app.get("/health")
def health() -> JSONResponse:
    missing = [
        name
        for name, module in (("paddleocr", PaddleOCR), ("pymupdf", fitz), ("pillow", Image))
        if module is None
    ]
    status = "ok" if not missing else "degraded"
    return JSONResponse(
        status_code=200 if status == "ok" else 503,
        content={
            "status": status,
            "engine": "paddleocr",
            "languages": DEFAULT_LANGUAGES,
            "models_loaded": bool(_engines),
            "missing_dependencies": missing,
        },
    )


@app.post("/ocr")
async def ocr(
    file: UploadFile = File(...),
    languages: str = Form(""),
    dpi: int = Form(200),
) -> JSONResponse:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")

    requested = [lang.strip() for lang in languages.split(",") if lang.strip()] or DEFAULT_LANGUAGES
    content_type = (file.content_type or "").lower()
    filename = (file.filename or "").lower()

    if content_type == "application/pdf" or filename.endswith(".pdf"):
        images = _pdf_to_arrays(data, dpi)
    else:
        images = [_image_to_array(data)]

    pages: list[Page] = []
    for index, image in enumerate(images, start=1):
        height, width = image.shape[0], image.shape[1]
        page = Page(page_number=index, width=int(width), height=int(height))

        lines = _run_engine(image, requested[0])
        for extra_language in requested[1:]:
            lines = _merge(lines, _run_engine(image, extra_language))

        # Top-to-bottom, then left-to-right; the Node side re-sorts, but a sane
        # order here keeps the raw payload readable while debugging.
        page.lines = sorted(lines, key=lambda line: (round(line.y0, 1), line.x0))
        if not page.lines:
            page.warnings.append("no text was detected on this page")
        pages.append(page)

    if not pages:
        raise HTTPException(status_code=422, detail="the document contained no pages")

    return JSONResponse(
        content={
            "engine": f"paddleocr:{','.join(requested)}",
            "languages": requested,
            "pages": [page.as_dict() for page in pages],
        }
    )
