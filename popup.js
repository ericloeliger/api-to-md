let isCapturing = false;

// DEFAULT_SETTINGS comes from settings.js
const SETTING_IDS = Object.keys(DEFAULT_SETTINGS);

// Initialize popup state & settings on load
document.addEventListener("DOMContentLoaded", () => {
  chrome.runtime.sendMessage({ action: "getSummaries" }, (response) => {
    if (!response) return;
    showStorageWarning(response.storageFull);
    if (response.isCapturing) {
      setCapturingState(true);
      startPolling();
    } else if (response.requests.length) {
      updateLog(response.requests);
    }
  });

  chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
    SETTING_IDS.forEach((id) => {
      document.getElementById(id).checked = items[id];
    });
  });
});

// Save settings when toggles change
SETTING_IDS.forEach((id) => {
  document.getElementById(id).addEventListener("change", updateSettings);
});

function updateSettings() {
  const settings = {};
  SETTING_IDS.forEach((id) => {
    settings[id] = document.getElementById(id).checked;
  });
  chrome.runtime.sendMessage({ action: "updateSettings", settings });
}

document.getElementById("toggleBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!isCapturing) {
    chrome.runtime.sendMessage({ action: "startCapture", tabId: tab.id }, (response) => {
      if (response && response.success) {
        setCapturingState(true);
        startPolling();
      } else {
        alert("Error starting capture: " + (response ? response.error : "Unknown error"));
      }
    });
  } else {
    chrome.runtime.sendMessage({ action: "stopCapture" }, () => {
      setCapturingState(false);
      document.getElementById("log").textContent = "Capture stopped.";
    });
  }
});

document.getElementById("clearBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "clearRequests" }, () => {
    showStorageWarning(false);
    updateLog([]);
  });
});

function showStorageWarning(show) {
  document.getElementById("warning").hidden = !show;
}

function setCapturingState(capturing) {
  isCapturing = capturing;
  const btn = document.getElementById("toggleBtn");
  btn.textContent = capturing ? "Stop Capturing" : "Start Capturing";
  btn.classList.toggle("danger", capturing);
  btn.classList.toggle("primary", !capturing);
}

function startPolling() {
  if (!isCapturing) return;
  chrome.runtime.sendMessage({ action: "getSummaries" }, (response) => {
    if (!response || !isCapturing) return;
    showStorageWarning(response.storageFull);
    if (!response.isCapturing) {
      // The debugger was detached outside the popup (e.g. the infobar was dismissed)
      setCapturingState(false);
      document.getElementById("log").textContent = "Capture stopped: the debugger was detached.";
      return;
    }
    updateLog(response.requests);
  });
  setTimeout(startPolling, 1000);
}

document.getElementById("copyAllBtn").addEventListener("click", () => {
  getFormattedMarkdown((markdown) => {
    if (!markdown) return alert("No requests captured yet!");
    navigator.clipboard.writeText(markdown).then(() => {
      alert("Copied all requests as Markdown to clipboard!");
    });
  });
});

document.getElementById("downloadBtn").addEventListener("click", () => {
  getFormattedMarkdown((markdown) => {
    if (!markdown) return alert("No requests captured yet!");
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `api-requests-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  });
});

function getFormattedMarkdown(callback) {
  chrome.runtime.sendMessage({ action: "getRequests" }, (response) => {
    if (!response || !response.requests.length) {
      callback(null);
      return;
    }
    const includeHeaders = document.getElementById("includeHeaders").checked;
    const markdown = response.requests.map(r => formatRequestToMarkdown(r, includeHeaders)).join("\n\n---\n\n");
    callback(markdown);
  });
}

function updateLog(requests) {
  const logDiv = document.getElementById("log");
  if (requests.length === 0) {
    logDiv.textContent = isCapturing ? "Capturing... waiting for API requests..." : "No requests captured yet...";
    return;
  }
  // Built with text nodes so URLs are never interpreted as HTML
  logDiv.replaceChildren(...requests.map((r) => {
    const row = document.createElement("div");
    const status = document.createElement("b");
    status.textContent = `[${r.status}]`;
    const url = r.url.length > 50 ? r.url.substring(0, 50) + "..." : r.url;
    row.append(status, ` ${r.method} ${url}`);
    return row;
  }));
}

function longestBacktickRun(text) {
  return (text.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
}

// Fences are made longer than any backtick run in the content so it can't close them early.
function codeBlock(content, lang) {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `${fence}${lang}\n${content}\n${fence}\n`;
}

function inlineCode(text) {
  const fence = "`".repeat(longestBacktickRun(text) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function getHeader(headers, name) {
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : "";
}

function langFromContentType(contentType) {
  const type = (contentType || "").toLowerCase();
  if (type.includes("json")) return "json";
  if (type.includes("html")) return "html";
  if (type.includes("xml")) return "xml";
  if (type.includes("javascript")) return "javascript";
  if (type.includes("css")) return "css";
  return "";
}

// Re-indents valid JSON without parsing values, so number literals such as
// 64-bit IDs are kept exactly (a JSON.parse/stringify round trip rounds them).
function prettyPrintJson(text) {
  JSON.parse(text); // throws if the text isn't valid JSON
  let out = "";
  let depth = 0;
  let inString = false;
  const newline = () => "\n" + "  ".repeat(depth);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    }
    else if (c === '"') {
      inString = true;
      out += c;
    }
    else if (c === "{" || c === "[") {
      let j = i + 1;
      while (/\s/.test(text[j])) j++;
      if (text[j] === (c === "{" ? "}" : "]")) {
        out += c + text[j];
        i = j;
      } else {
        depth++;
        out += c + newline();
      }
    }
    else if (c === "}" || c === "]") {
      depth--;
      out += newline() + c;
    }
    else if (c === ",") out += "," + newline();
    else if (c === ":") out += ": ";
    else if (!/\s/.test(c)) out += c;
  }
  return out;
}

function formatBody(text, contentType) {
  try {
    return codeBlock(prettyPrintJson(text), "json");
  } catch (e) {
    // Keep raw text if not valid JSON
    return codeBlock(text, langFromContentType(contentType));
  }
}

function formatResponseBody(r) {
  if (r.responseBody === null || r.responseBody === undefined) return "_No response body captured_\n";
  if (r.responseBody === "") return "_Empty response body_\n";
  return formatBody(r.responseBody, r.mimeType);
}

function formatRequestToMarkdown(r, includeHeaders) {
  const sections = [`### API Request: ${r.method} ${inlineCode(r.url)}
- **Timestamp:** ${r.timestamp}
- **Status:** ${r.status}
${r.redirectedTo ? `- **Redirected to:** ${inlineCode(r.redirectedTo)}\n` : ""}`];

  if (includeHeaders) {
    sections.push(`#### Request Headers\n${codeBlock(JSON.stringify(r.headers || {}, null, 2), "json")}`);
  }

  if (r.postData) {
    sections.push(`#### Request Payload\n${formatBody(r.postData, getHeader(r.headers, "content-type"))}`);
  }

  // A redirect hop has no body of its own; the next entry holds the final response.
  if (!r.redirectedTo) {
    sections.push(`#### Response Body\n${formatResponseBody(r)}`);
  }

  return sections.join("\n").trimEnd();
}
