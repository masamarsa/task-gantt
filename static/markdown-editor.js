"use strict";

const openMarkdownEditor = (() => {
  const dialog = document.getElementById("markdown-editor");
  const title = document.getElementById("markdown-editor-title");
  const input = document.getElementById("markdown-editor-text");
  const preview = document.getElementById("markdown-preview");
  const writeTab = document.getElementById("markdown-write-tab");
  const previewTab = document.getElementById("markdown-preview-tab");
  const error = document.getElementById("markdown-editor-error");
  const toolbar = dialog.querySelector(".markdown-editor-toolbar");
  let target;
  let opener;
  let previewRequest;

  function showError(message = "") {
    error.textContent = message;
    error.hidden = !message;
  }

  function cancelPreview() {
    previewRequest?.abort();
    previewRequest = null;
    preview.removeAttribute("aria-busy");
  }

  function switchMode(showPreview) {
    cancelPreview();
    showError();
    writeTab.setAttribute("aria-pressed", String(!showPreview));
    previewTab.setAttribute("aria-pressed", String(showPreview));
    input.hidden = showPreview;
    if (toolbar) toolbar.hidden = showPreview;
    preview.hidden = !showPreview;
  }

  async function showPreview() {
    switchMode(true);
    if (!input.value.trim()) {
      preview.textContent = "プレビューする内容がありません。";
      return;
    }

    const controller = new AbortController();
    const fieldName = target.name;
    previewRequest = controller;
    preview.textContent = "プレビューを読み込んでいます…";
    preview.setAttribute("aria-busy", "true");
    try {
      const response = await fetch("/api/markdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [fieldName]: input.value }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || typeof data[fieldName] !== "string") {
        throw new Error(data.error);
      }
      if (previewRequest !== controller) return;
      // The server renders escaped Markdown and validates link destinations.
      preview.innerHTML = data[fieldName];
    } catch {
      if (previewRequest !== controller) return;
      preview.replaceChildren();
      showError("プレビューを表示できませんでした。入力内容は保持されています。");
    } finally {
      if (previewRequest === controller) cancelPreview();
    }
  }

  function insertFormat(format) {
    let start = input.selectionStart;
    let end = input.selectionEnd;
    let selected = input.value.slice(start, end);
    let before = "";
    let after = "";

    if (format === "list") {
      start = start === 0 ? 0 : input.value.lastIndexOf("\n", start - 1) + 1;
      const lastLine = input.value.indexOf("\n", Math.max(start, end - 1));
      end = lastLine === -1 ? input.value.length : lastLine;
      selected = input.value.slice(start, end) || "項目";
      selected = selected.replace(/^(.+)/gm, "- $1");
    } else if (format === "code") {
      selected ||= "コード";
      const multiline = selected.includes("\n");
      const longestRun = Math.max(0, ...(selected.match(/`+/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(Math.max(multiline ? 3 : 1, longestRun + 1));
      if (multiline) {
        const atLineStart = start === 0 || input.value[start - 1] === "\n";
        before = (atLineStart ? "" : "\n") + fence + "\n";
        after = "\n" + fence + "\n";
      } else {
        const needsPadding = selected.startsWith("`") || selected.endsWith("`")
          || (selected.startsWith(" ") && selected.endsWith(" ") && selected.trim());
        before = fence + (needsPadding ? " " : "");
        after = (needsPadding ? " " : "") + fence;
      }
    } else if (format === "bold") {
      selected ||= "太字";
      before = after = "**";
    }

    const replacement = before + selected + after;
    if (input.value.length - (end - start) + replacement.length > input.maxLength) {
      showError("入力できる文字数を超えています。");
      return;
    }
    showError();
    input.setRangeText(replacement, start, end);
    input.setSelectionRange(start + before.length, start + before.length + selected.length);
    input.focus();
  }

  toolbar?.querySelectorAll("[data-markdown-format]").forEach((button) => {
    button.addEventListener("click", () => insertFormat(button.dataset.markdownFormat));
  });
  input.addEventListener("input", () => showError());
  writeTab.addEventListener("click", () => switchMode(false));
  previewTab.addEventListener("click", showPreview);
  document.getElementById("markdown-editor-apply").addEventListener("click", () => {
    target.value = input.value;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    dialog.close();
  });
  for (const id of ["markdown-editor-cancel", "markdown-editor-close"]) {
    document.getElementById(id).addEventListener("click", () => dialog.close());
  }
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    cancelPreview();
    opener?.focus({ preventScroll: true });
    opener = null;
    target = null;
  });

  return (field, label, trigger = document.activeElement) => {
    if (dialog.open) return;
    target = field;
    opener = trigger;
    title.textContent = label + "を入力";
    input.value = field.value;
    switchMode(false);
    dialog.showModal();
    input.focus({ preventScroll: true });
  };
})();
