/**
 * Kitab AI - Frontend Application Logic
 */

// ---------------------------------------------------------------------------
// 1. State
// ---------------------------------------------------------------------------

let docId = null;
let filename = "";
let messages = [];
let busy = false;

// ---------------------------------------------------------------------------
// 2. DOM References
// ---------------------------------------------------------------------------

const dom = {};

function initDomReferences() {
  dom.brandLogo = document.getElementById("brand-logo");
  dom.brandWordmark = document.getElementById("brand-wordmark");
  dom.btnNewDoc = document.getElementById("btn-new-doc");
  dom.errorContainer = document.getElementById("error-container");
  dom.uploadView = document.getElementById("upload-view");
  dom.chatView = document.getElementById("chat-view");
  dom.dropZone = document.getElementById("drop-zone");
  dom.fileInput = document.getElementById("file-input");
  dom.uploadStatus = document.getElementById("upload-status");
  dom.uploadStatusText = document.getElementById("upload-status-text");
  dom.docFilename = document.getElementById("doc-filename");
  dom.docPages = document.getElementById("doc-pages");
  dom.chatMessages = document.getElementById("chat-messages");
  dom.emptyState = document.getElementById("empty-state");
  dom.chatForm = document.getElementById("chat-form");
  dom.questionInput = document.getElementById("question-input");
  dom.btnSend = document.getElementById("btn-send");
  dom.exampleButtons = document.querySelectorAll(".example-btn");
}

// ---------------------------------------------------------------------------
// 3. API Calls
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    if (error.name === "AbortError") {
      throw new Error("Request timed out. Please try again.");
    }
    throw new Error("Network error. Please check your connection.");
  }
}

async function apiUpload(file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetchWithTimeout("/upload", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    let errorDetail = "Upload failed.";
    try {
      const data = await response.json();
      if (data && data.detail) {
        errorDetail = data.detail;
      }
    } catch {
      errorDetail = `Upload failed with status ${response.status}.`;
    }
    throw new Error(errorDetail);
  }

  return await response.json();
}

async function apiAsk(documentId, questionText) {
  const response = await fetchWithTimeout("/ask", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      doc_id: documentId,
      question: questionText,
    }),
  });

  if (!response.ok) {
    let errorDetail = "Failed to get answer.";
    try {
      const data = await response.json();
      if (data && data.detail) {
        errorDetail = data.detail;
      }
    } catch {
      errorDetail = `Request failed with status ${response.status}.`;
    }
    throw new Error(errorDetail);
  }

  return await response.json();
}

// ---------------------------------------------------------------------------
// 4. UI Helpers
// ---------------------------------------------------------------------------

function showError(message) {
  const banner = document.createElement("div");
  banner.className = "error-banner";

  const textSpan = document.createElement("span");
  textSpan.textContent = message;

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "error-close-btn";
  closeButton.setAttribute("aria-label", "Dismiss error message");
  closeButton.textContent = "×";
  closeButton.addEventListener("click", () => banner.remove());

  banner.appendChild(textSpan);
  banner.appendChild(closeButton);
  dom.errorContainer.appendChild(banner);
}

function clearErrors() {
  while (dom.errorContainer.firstChild) {
    dom.errorContainer.removeChild(dom.errorContainer.firstChild);
  }
}

function setBusy(isBusy) {
  busy = isBusy;
  dom.btnSend.disabled = isBusy;
  dom.questionInput.disabled = isBusy;
}

function showUploadLoading(isLoading) {
  if (isLoading) {
    dom.uploadStatus.classList.remove("hidden");
    dom.dropZone.classList.add("hidden");
  } else {
    dom.uploadStatus.classList.add("hidden");
    dom.dropZone.classList.remove("hidden");
  }
}

function scrollToBottom() {
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function resizeTextarea() {
  dom.questionInput.style.height = "auto";
  const newHeight = Math.min(dom.questionInput.scrollHeight, 130);
  dom.questionInput.style.height = `${newHeight}px`;
}

function showTypingIndicator() {
  const card = document.createElement("div");
  card.id = "typing-indicator";
  card.className = "typing-card";

  const label = document.createElement("span");
  label.className = "typing-text";
  label.textContent = "Analyzing document";

  const dots = document.createElement("div");
  dots.className = "typing-dots";
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("span");
    dot.className = "typing-dot";
    dots.appendChild(dot);
  }

  card.appendChild(label);
  card.appendChild(dots);
  dom.chatMessages.appendChild(card);
  scrollToBottom();
}

function removeTypingIndicator() {
  const indicator = document.getElementById("typing-indicator");
  if (indicator) {
    indicator.remove();
  }
}

function appendAnswerCard(questionText, answerText, sourcesList) {
  if (dom.emptyState) {
    dom.emptyState.classList.add("hidden");
  }

  const card = document.createElement("article");
  card.className = "message-card";

  // Question header
  const questionBox = document.createElement("div");
  questionBox.className = "message-question-wrapper";

  const questionLabel = document.createElement("div");
  questionLabel.className = "message-question-label";
  questionLabel.textContent = "Question";

  const questionContent = document.createElement("div");
  questionContent.className = "message-question-text";
  questionContent.textContent = questionText;

  questionBox.appendChild(questionLabel);
  questionBox.appendChild(questionContent);
  card.appendChild(questionBox);

  // Answer
  const answerContent = document.createElement("p");
  answerContent.className = "message-answer-text";
  answerContent.textContent = answerText;
  card.appendChild(answerContent);

  // Collapsible Sources
  if (Array.isArray(sourcesList) && sourcesList.length > 0) {
    const details = document.createElement("details");
    details.className = "sources-details";

    const summary = document.createElement("summary");
    summary.className = "sources-summary";
    summary.textContent = `Sources (${sourcesList.length})`;
    details.appendChild(summary);

    const list = document.createElement("ul");
    list.className = "sources-list";

    sourcesList.forEach((source) => {
      const item = document.createElement("li");
      item.className = "source-item";

      const badge = document.createElement("span");
      badge.className = "page-badge";
      badge.textContent = `Page ${source.page}`;

      const passage = document.createElement("p");
      passage.className = "source-passage";
      passage.textContent = source.text;

      item.appendChild(badge);
      item.appendChild(passage);
      list.appendChild(item);
    });

    details.appendChild(list);
    card.appendChild(details);
  }

  dom.chatMessages.appendChild(card);
  scrollToBottom();
}

function validateFile(file) {
  if (!file) {
    return "No file selected.";
  }
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return "Please upload a PDF document.";
  }
  const maxBytes = 20 * 1024 * 1024;
  if (file.size > maxBytes) {
    return "File exceeds the 20 MB size limit.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5. Event Handlers
// ---------------------------------------------------------------------------

async function handleFileProcess(file) {
  clearErrors();
  const validationError = validateFile(file);
  if (validationError) {
    showError(validationError);
    return;
  }

  showUploadLoading(true);

  try {
    const result = await apiUpload(file);
    docId = result.doc_id;
    filename = result.filename;
    messages = [];

    // Update document bar
    dom.docFilename.textContent = result.filename;
    dom.docPages.textContent = `${result.pages} page${result.pages === 1 ? "" : "s"}`;

    // Switch views
    dom.uploadView.classList.add("hidden");
    dom.chatView.classList.remove("hidden");
    dom.btnNewDoc.classList.remove("hidden");

    // Clear chat contents except empty state
    const cards = dom.chatMessages.querySelectorAll(".message-card");
    cards.forEach((card) => card.remove());
    dom.emptyState.classList.remove("hidden");

    dom.questionInput.value = "";
    resizeTextarea();
    dom.questionInput.focus();
  } catch (err) {
    showError(err.message);
  } finally {
    showUploadLoading(false);
    dom.fileInput.value = "";
  }
}

async function handleQuestionSubmit(questionText) {
  const query = questionText.trim();
  if (!query || busy || !docId) {
    return;
  }

  clearErrors();
  setBusy(true);
  dom.questionInput.value = "";
  resizeTextarea();

  showTypingIndicator();

  try {
    const result = await apiAsk(docId, query);
    removeTypingIndicator();
    appendAnswerCard(query, result.answer, result.sources);
    messages.push({ question: query, answer: result.answer, sources: result.sources });
  } catch (err) {
    removeTypingIndicator();
    showError(err.message);
  } finally {
    setBusy(false);
    dom.questionInput.focus();
  }
}

function handleReset() {
  docId = null;
  filename = "";
  messages = [];
  setBusy(false);

  clearErrors();
  dom.chatView.classList.add("hidden");
  dom.uploadView.classList.remove("hidden");
  dom.btnNewDoc.classList.add("hidden");

  const cards = dom.chatMessages.querySelectorAll(".message-card");
  cards.forEach((card) => card.remove());
  dom.emptyState.classList.remove("hidden");

  dom.questionInput.value = "";
  resizeTextarea();
}

// ---------------------------------------------------------------------------
// 6. Init
// ---------------------------------------------------------------------------

function init() {
  initDomReferences();

  // Logo fallback to wordmark
  dom.brandLogo.addEventListener("error", () => {
    dom.brandLogo.classList.add("hidden");
    dom.brandWordmark.classList.remove("hidden");
  });

  // Drop zone is a <label for="file-input"> so it opens the picker natively on click.
  // We only need keydown for keyboard accessibility (Enter/Space on the focused label).
  dom.dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      dom.fileInput.click();
    }
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    dom.dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dom.dropZone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dom.dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dom.dropZone.classList.remove("dragover");
    });
  });

  dom.dropZone.addEventListener("drop", (e) => {
    const droppedFiles = e.dataTransfer.files;
    if (droppedFiles && droppedFiles.length > 0) {
      handleFileProcess(droppedFiles[0]);
    }
  });

  dom.fileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileProcess(e.target.files[0]);
    }
  });

  // Question input events
  dom.questionInput.addEventListener("input", resizeTextarea);

  dom.questionInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleQuestionSubmit(dom.questionInput.value);
    }
  });

  dom.chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    handleQuestionSubmit(dom.questionInput.value);
  });

  // Example question buttons
  dom.exampleButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const questionText = btn.textContent.trim();
      handleQuestionSubmit(questionText);
    });
  });

  // Reset button
  dom.btnNewDoc.addEventListener("click", handleReset);
}

document.addEventListener("DOMContentLoaded", init);
