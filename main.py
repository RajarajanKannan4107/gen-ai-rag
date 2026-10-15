"""
Kitab AI - Ask your papers anything.

Run instructions:
1. python -m venv venv && source venv/bin/activate   (Windows: venv\\Scripts\\activate)
2. pip install -r requirements.txt
3. cp .env.example .env   (then add your key from console.groq.com)
4. uvicorn main:app --reload --port 8000   → open http://localhost:8000
"""

import io
import logging
import os
from pathlib import Path
import uuid
from typing import Any, Dict, List

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from groq import Groq
import numpy as np
import pypdf
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

# ---------------------------------------------------------------------------
# Config & Initialization
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent

load_dotenv(BASE_DIR / ".env")

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
if not GROQ_API_KEY or GROQ_API_KEY == "your_key_here":
    raise RuntimeError(
        "GROQ_API_KEY is missing. Please copy .env.example to .env and add your Groq API key."
    )

MODEL_NAME = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
EMBEDDING_MODEL_NAME = "all-MiniLM-L6-v2"
MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB
CHUNK_SIZE = 800
CHUNK_OVERLAP = 150
MIN_CHUNK_LENGTH = 50
TOP_K_RETRIEVAL = 4
TOP_K_SOURCES = 3

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("kitab-ai")

groq_client = Groq(api_key=GROQ_API_KEY)
app = FastAPI(title="Kitab AI")

# In-memory document store: { doc_id: { "filename": str, "pages": int, "chunks": list, "embeddings": np.ndarray } }
documents: Dict[str, Dict[str, Any]] = {}

# Load local CPU embedding model once on startup
logger.info("Loading embedding model %s...", EMBEDDING_MODEL_NAME)
embed_model = SentenceTransformer(EMBEDDING_MODEL_NAME)
logger.info("Embedding model loaded.")

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class UploadResponse(BaseModel):
    doc_id: str
    filename: str
    pages: int
    chunks: int

class AskRequest(BaseModel):
    doc_id: str
    question: str

class SourceItem(BaseModel):
    page: int
    text: str

class AskResponse(BaseModel):
    answer: str
    sources: List[SourceItem]

class HealthResponse(BaseModel):
    status: str

# ---------------------------------------------------------------------------
# PDF and Chunking
# ---------------------------------------------------------------------------

def extract_pdf_pages(file_bytes: bytes) -> List[Dict[str, Any]]:
    """Extract page text using pypdf, preserving 1-based page numbers."""
    try:
        reader = pypdf.PdfReader(io.BytesIO(file_bytes))
    except Exception as exc:
        logger.warning("PDF parsing error: %s", exc)
        raise HTTPException(status_code=400, detail="Invalid or corrupt PDF file.")

    pages_data = []
    has_text = False

    for page_idx, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        if text.strip():
            has_text = True
        pages_data.append({"page": page_idx, "text": text})

    if not has_text:
        raise HTTPException(
            status_code=422,
            detail="Could not extract text. Scanned PDFs are not supported.",
        )

    return pages_data


def chunk_pages(pages_data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Chunk each page separately with sliding window; skip tiny chunks."""
    chunks: List[Dict[str, Any]] = []
    step = CHUNK_SIZE - CHUNK_OVERLAP

    for item in pages_data:
        page_num = item["page"]
        raw_text = item["text"].strip()
        if not raw_text:
            continue

        text_length = len(raw_text)
        start = 0

        while start < text_length:
            end = min(start + CHUNK_SIZE, text_length)
            chunk_content = raw_text[start:end].strip()

            if len(chunk_content) >= MIN_CHUNK_LENGTH:
                chunks.append({"page": page_num, "text": chunk_content})

            if end >= text_length:
                break
            start += step

    if not chunks:
        raise HTTPException(
            status_code=422,
            detail="Could not extract text. Scanned PDFs are not supported.",
        )

    return chunks

# ---------------------------------------------------------------------------
# Embeddings & Retrieval
# ---------------------------------------------------------------------------

def embed_texts(texts: List[str]) -> np.ndarray:
    """Compute normalized vector embeddings for a list of texts."""
    embeddings = embed_model.encode(texts, normalize_embeddings=True, convert_to_numpy=True)
    return np.asarray(embeddings, dtype=np.float32)


def retrieve_relevant_chunks(doc: Dict[str, Any], question: str) -> List[Dict[str, Any]]:
    """Retrieve top-k chunks by cosine similarity using dot product of normalized vectors."""
    q_emb = embed_model.encode([question], normalize_embeddings=True, convert_to_numpy=True)
    q_vec = np.asarray(q_emb[0], dtype=np.float32)

    doc_embs: np.ndarray = doc["embeddings"]
    similarity_scores = np.dot(doc_embs, q_vec)

    k = min(TOP_K_RETRIEVAL, len(similarity_scores))
    top_indices = np.argsort(similarity_scores)[::-1][:k]

    return [doc["chunks"][idx] for idx in top_indices]

# ---------------------------------------------------------------------------
# LLM
# ---------------------------------------------------------------------------

def generate_answer(question: str, context_chunks: List[Dict[str, Any]]) -> str:
    """Call Groq to answer using only provided context."""
    formatted_passages = []
    for idx, chunk in enumerate(context_chunks, start=1):
        formatted_passages.append(f"Passage {idx} (Page {chunk['page']}):\n{chunk['text']}")

    context_prompt = "\n\n".join(formatted_passages)
    user_content = f"Context passages:\n{context_prompt}\n\nQuestion: {question}"

    system_content = (
        "You are a research assistant. Answer ONLY using the provided context from the paper. "
        "If the answer is not in the context, say you could not find it in the document. "
        "Be concise and accurate. Do not invent citations."
    )

    try:
        response = groq_client.chat.completions.create(
            model=MODEL_NAME,
            messages=[
                {"role": "system", "content": system_content},
                {"role": "user", "content": user_content},
            ],
            temperature=0.2,
        )
        return response.choices[0].message.content or ""
    except Exception as exc:
        logger.exception("Groq request failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail="The language model request failed. Please try again.",
        )

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health", response_model=HealthResponse)
def health():
    return HealthResponse(status="ok")


@app.get("/", include_in_schema=False)
def serve_index():
    index_path = BASE_DIR / "index.html"
    if not index_path.is_file():
        raise HTTPException(status_code=404, detail="index.html not found.")
    return FileResponse(index_path)


@app.get("/styles.css", include_in_schema=False)
def serve_styles():
    css_path = BASE_DIR / "styles.css"
    if not css_path.is_file():
        raise HTTPException(status_code=404, detail="styles.css not found.")
    return FileResponse(css_path, media_type="text/css")


@app.get("/script.js", include_in_schema=False)
def serve_script():
    js_path = BASE_DIR / "script.js"
    if not js_path.is_file():
        raise HTTPException(status_code=404, detail="script.js not found.")
    return FileResponse(js_path, media_type="application/javascript")


@app.get("/assets/logo.svg", include_in_schema=False)
def serve_logo():
    logo_path = BASE_DIR / "assets" / "logo.svg"
    if not logo_path.is_file():
        raise HTTPException(status_code=404, detail="Logo not found.")
    return FileResponse(logo_path, media_type="image/svg+xml")


@app.post("/upload", response_model=UploadResponse)
def upload_document(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    try:
        content = file.file.read()
    except Exception as exc:
        logger.warning("Error reading uploaded file: %s", exc)
        raise HTTPException(status_code=400, detail="Could not read uploaded file.")

    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="File size exceeds the 20 MB limit.")

    pages_data = extract_pdf_pages(content)
    chunks = chunk_pages(pages_data)

    chunk_texts = [item["text"] for item in chunks]
    embeddings = embed_texts(chunk_texts)

    doc_id = uuid.uuid4().hex
    documents[doc_id] = {
        "filename": file.filename,
        "pages": len(pages_data),
        "chunks": chunks,
        "embeddings": embeddings,
    }

    return UploadResponse(
        doc_id=doc_id,
        filename=file.filename,
        pages=len(pages_data),
        chunks=len(chunks),
    )


@app.post("/ask", response_model=AskResponse)
def ask_question(payload: AskRequest):
    doc_id = payload.doc_id.strip()
    question = payload.question.strip()

    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    doc = documents.get(doc_id)
    if not doc:
        raise HTTPException(
            status_code=404,
            detail="Document not found. Please upload it again.",
        )

    top_chunks = retrieve_relevant_chunks(doc, question)
    answer = generate_answer(question, top_chunks)

    sources = [
        SourceItem(
            page=chunk["page"],
            text=chunk["text"][:400].strip(),
        )
        for chunk in top_chunks[:TOP_K_SOURCES]
    ]

    return AskResponse(answer=answer, sources=sources)
