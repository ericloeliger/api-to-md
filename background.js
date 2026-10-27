importScripts("settings.js");

const REQUEST_KEY_PREFIX = "request:";
const BINARY_MIME = /^(image|audio|video|font)\/|^application\/(pdf|zip|gzip|wasm)/;
// Datadog's browser SDK sends to sibling hosts rather than subdomains, e.g.
// browser-intake-datadoghq.com, browser-intake-us5-datadoghq.com, browser-intake-datadoghq.eu.
const DATADOG_INTAKE = /(^|\.)browser-intake-([a-z0-9]+-)?(datadoghq\.(com|eu)|ddog-gov\.com)$/;

let capturedRequests = {};
let activeTabId = null;
let settings = { ...DEFAULT_SETTINGS };
let storageFull = false;

// The service worker can be stopped at any time, so capture state lives in
// chrome.storage.session (cleared when the browser closes) and is restored here.
// Each request is stored under its own key so a save only writes what changed.
const ready = Promise.all([
  chrome.storage.local.get(DEFAULT_SETTINGS).then((items) => {
    settings = items;
  }),
  chrome.storage.session.get(null).then((items) => {
    activeTabId = items.activeTabId ?? null;
    for (const [key, value] of Object.entries(items)) {
      if (key.startsWith(REQUEST_KEY_PREFIX)) {
        capturedRequests[key.slice(REQUEST_KEY_PREFIX.length)] = value;
      }
    }
  })
]).catch((err) => {
  console.error("Could not restore saved state:", err);
});

const dirtyIds = new Set();
let saveTimer = null;

// Throttled rather than debounced, so a steady stream of requests still gets saved.
function saveRequest(requestId) {
  dirtyIds.add(requestId);
  if (saveTimer) return;
  saveTimer = setTimeout(flushRequests, 250);
}

function flushRequests() {
  saveTimer = null;
  const toSet = {};
  const toRemove = [];
  for (const id of dirtyIds) {
    const key = REQUEST_KEY_PREFIX + id;
    if (capturedRequests[id]) toSet[key] = capturedRequests[id];
    else toRemove.push(key);
  }
  dirtyIds.clear();

  if (toRemove.length) chrome.storage.session.remove(toRemove);
  chrome.storage.session.set(toSet).catch((err) => {
    // Stays set until the requests are cleared; the popup shows a warning.
    storageFull = true;
    console.warn("Could not persist captured requests:", err);
  });
}

function setActiveTabId(tabId) {
  activeTabId = tabId;
  chrome.storage.session.set({ activeTabId });
}

function sortedRequests() {
  return Object.values(capturedRequests).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  ready
    .then(() => handleMessage(request, sendResponse))
    .catch((err) => sendResponse({ success: false, error: String(err) }));
  return true;
});

// Listeners are registered at top level so events wake a stopped worker.
chrome.debugger.onEvent.addListener((source, method, params) => {
  ready.then(() => onDebuggerEvent(source, method, params));
});

chrome.debugger.onDetach.addListener((source) => {
  ready.then(() => {
    if (source.tabId === activeTabId) setActiveTabId(null);
  });
});

function handleMessage(request, sendResponse) {
  if (request.action === "startCapture") {
    attachDebugger(request.tabId, (err) => {
      if (err) sendResponse({ success: false, error: err });
      else sendResponse({ success: true });
    });
  }
  else if (request.action === "stopCapture") {
    detachDebugger(() => sendResponse({ success: true }));
  }
  else if (request.action === "getState") {
    sendResponse({ isCapturing: activeTabId !== null });
  }
  else if (request.action === "getSummaries") {
    // Just what the popup log shows, so polling doesn't copy every body each second.
    sendResponse({
      requests: sortedRequests().map(({ status, method, url }) => ({ status, method, url })),
      isCapturing: activeTabId !== null,
      storageFull
    });
  }
  else if (request.action === "getRequests") {
    sendResponse({ requests: sortedRequests(), isCapturing: activeTabId !== null });
  }
  else if (request.action === "clearRequests") {
    const ids = Object.keys(capturedRequests);
    capturedRequests = {};
    storageFull = false;
    ids.forEach(saveRequest);
    sendResponse({ success: true });
  }
  else if (request.action === "updateSettings") {
    settings = { ...DEFAULT_SETTINGS, ...request.settings };
    chrome.storage.local.set(settings);
    sendResponse({ success: true });
  }
  else {
    sendResponse({ success: false, error: `Unknown action: ${request.action}` });
  }
}

function attachDebugger(tabId, callback) {
  // Always detach first, even from the same tab, in case our state went stale.
  if (activeTabId !== null) {
    detachDebugger(() => attachDebugger(tabId, callback));
    return;
  }
  const target = { tabId: tabId };

  chrome.debugger.attach(target, "1.3", () => {
    if (chrome.runtime.lastError) {
      callback(chrome.runtime.lastError.message);
      return;
    }
    setActiveTabId(tabId);

    chrome.debugger.sendCommand(target, "Network.enable", {}, () => {
      if (chrome.runtime.lastError) {
        const message = chrome.runtime.lastError.message;
        detachDebugger(() => callback(message));
        return;
      }
      callback(null);
    });
  });
}

function detachDebugger(done) {
  const tabId = activeTabId;
  if (tabId === null) {
    if (done) done();
    return;
  }
  setActiveTabId(null);
  chrome.debugger.detach({ tabId }, () => {
    void chrome.runtime.lastError;
    if (done) done();
  });
}

function isExcluded(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch (e) {
    return false;
  }
  const excludedDomains = [];
  if (settings.excludeMixpanel) excludedDomains.push("mixpanel.com");
  if (settings.excludeChurnZero) excludedDomains.push("churnzero.net");
  if (settings.excludeDatadog) {
    if (DATADOG_INTAKE.test(host)) return true;
    excludedDomains.push("datadoghq.com", "datadoghq.eu", "ddog-gov.com");
  }
  return excludedDomains.some((domain) => host === domain || host.endsWith("." + domain));
}

// Network.getResponseBody returns base64 for non-text bodies; atob alone
// yields Latin-1, so decode the bytes using the response's charset.
function decodeBody(body, base64Encoded, charset) {
  if (!base64Encoded) return body;
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  let decoder;
  try {
    decoder = new TextDecoder(charset || "utf-8", { fatal: true });
  } catch (e) {
    decoder = new TextDecoder("utf-8", { fatal: true });
  }
  try {
    return decoder.decode(bytes);
  } catch (e) {
    return `[binary response body, ${bytes.length} bytes, not shown]`;
  }
}

function onDebuggerEvent(source, method, params) {
  if (source.tabId !== activeTabId) return;
  const target = { tabId: activeTabId };

  if (method === "Network.requestWillBeSent") {
    const { requestId, request } = params;

    // A redirect reuses the requestId: keep the hop that redirected as its own
    // entry, and let the new URL be filtered and captured like a fresh request.
    if (params.redirectResponse && capturedRequests[requestId]) {
      const hopId = `${requestId}-${crypto.randomUUID()}`;
      capturedRequests[hopId] = {
        ...capturedRequests[requestId],
        requestId: hopId,
        status: params.redirectResponse.status,
        mimeType: params.redirectResponse.mimeType,
        redirectedTo: request.url
      };
      delete capturedRequests[requestId];
      saveRequest(hopId);
      saveRequest(requestId);
    }

    if (isExcluded(request.url)) {
      return;
    }

    if (params.type === "Fetch" || params.type === "XHR") {
      capturedRequests[requestId] = {
        requestId,
        url: request.url,
        method: request.method,
        headers: request.headers,
        postData: request.postData || null,
        timestamp: new Date().toISOString(),
        status: "Pending",
        responseBody: null
      };
      saveRequest(requestId);

      // Large payloads are omitted from the event and must be fetched separately.
      if (request.hasPostData && !request.postData) {
        chrome.debugger.sendCommand(target, "Network.getRequestPostData", { requestId }, (response) => {
          if (!chrome.runtime.lastError && response && capturedRequests[requestId]) {
            capturedRequests[requestId].postData = response.postData;
            saveRequest(requestId);
          }
        });
      }
    }
  }
  else if (method === "Network.responseReceived") {
    const { requestId, response } = params;
    if (capturedRequests[requestId]) {
      capturedRequests[requestId].status = response.status;
      capturedRequests[requestId].mimeType = response.mimeType;
      capturedRequests[requestId].charset = response.charset;
      saveRequest(requestId);
    }
  }
  else if (method === "Network.loadingFinished") {
    const { requestId } = params;
    const entry = capturedRequests[requestId];
    if (!entry) return;

    if (BINARY_MIME.test(entry.mimeType || "")) {
      entry.responseBody = `[binary response body (${entry.mimeType}), not captured]`;
      saveRequest(requestId);
      return;
    }

    chrome.debugger.sendCommand(target, "Network.getResponseBody", { requestId }, (response) => {
      if (!chrome.runtime.lastError && response && capturedRequests[requestId]) {
        const { charset } = capturedRequests[requestId];
        capturedRequests[requestId].responseBody = decodeBody(response.body, response.base64Encoded, charset);
        saveRequest(requestId);
      }
    });
  }
}
