# API Request to Markdown

A Chrome extension that records the API calls a web page makes and exports them as Markdown. Use it to document an undocumented API, attach real requests to a bug report, or give an LLM the exact payloads a site sends and receives.

## Features

- Captures `fetch` and `XMLHttpRequest` traffic from the active tab, including the method, URL, status, request headers, request payload and response body.
- Pretty-prints JSON bodies without parsing their values, so large numeric IDs (such as 64-bit IDs) keep every digit.
- Records each redirect hop as its own entry, with the URL it redirected to.
- Filters out common analytics and monitoring traffic (Mixpanel, ChurnZero, Datadog). Each filter can be turned off.
- Copies all captured requests to the clipboard or downloads them as a `.md` file.
- Keeps captures through service worker restarts by saving them to `chrome.storage.session`. They are cleared when the browser closes.

## Installation

The extension isn't on the Chrome Web Store, so you load it unpacked:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (the one that contains `manifest.json`).
4. Optionally, pin the extension to the toolbar.

It also works in other Chromium-based browsers that support Manifest V3, such as Edge and Brave.

## Usage

1. Open the page you want to capture and click the extension icon.
2. Click **Start Capturing**. Chrome attaches its debugger to the tab and shows a "started debugging this browser" banner. That banner is expected.
3. Use the site. Captured requests show up in the popup log.
4. Click **Copy All (MD)** or **Download .md** to export.
5. Click **Stop Capturing** when you're done, or **Clear** to empty the list.

Capture keeps running after you close the popup. If you dismiss Chrome's debugger banner, capture stops, and the popup tells you so.

### Options

| Option | Default | Effect |
| --- | --- | --- |
| Exclude Mixpanel | On | Skips requests to `mixpanel.com` and its subdomains. |
| Exclude ChurnZero | On | Skips requests to `churnzero.net` and its subdomains. |
| Exclude Datadog | On | Skips Datadog hosts, including browser intake hosts such as `browser-intake-datadoghq.com`. |
| Include Headers | On | Adds the request headers to the exported Markdown. |

Settings are saved and apply to new requests immediately.

## Output format

Each request becomes a section like this:

````markdown
### API Request: POST `https://api.example.com/v1/items`
- **Timestamp:** 2026-11-14T10:32:05.123Z
- **Status:** 201

#### Request Headers
```json
{
  "Content-Type": "application/json"
}
```

#### Request Payload
```json
{
  "name": "Widget"
}
```

#### Response Body
```json
{
  "id": 9007199254740993,
  "name": "Widget"
}
```
````

Requests are sorted by time and separated by `---`. Bodies that aren't JSON are kept as-is, in a code block labeled from the content type (HTML, XML, JavaScript, CSS). Code fences are made longer than any run of backticks in the content, so the content can't break the Markdown.

## Privacy

All captured data stays in your browser. The extension makes no network requests of its own.

Exports can contain sensitive data, such as `Authorization` headers, cookies, tokens and personal information in payloads. Review an export before you share it, and turn off **Include Headers** if you don't need them.

## Permissions

| Permission | Why it's needed |
| --- | --- |
| `debugger` | Reads network traffic, including response bodies, through the Chrome DevTools Protocol. |
| `activeTab` | Targets the tab you're on when you start capturing. |
| `storage` | Saves your settings and keeps captures through service worker restarts. |

## Limitations

- Only `fetch` and XHR requests are captured. Page loads, scripts, images, WebSocket messages and other resource types are not.
- Response headers aren't captured.
- Binary response bodies (images, audio, video, fonts, PDFs, archives, WebAssembly) are replaced with a placeholder that names the content type. Other bodies that can't be decoded as text are replaced with a placeholder that gives their size.
- Only one tab is captured at a time. Starting a capture on a new tab stops the previous one.
- Capture can't start if another debugger, such as another extension, is already attached to the tab. Chrome also doesn't allow attaching to `chrome://` pages or the Chrome Web Store.
- `chrome.storage.session` has a size limit. If a capture outgrows it, the popup shows a warning. Requests captured after that point are lost if the service worker restarts, so export or clear soon.

## Project structure

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension manifest (Manifest V3). |
| `background.js` | Service worker. Attaches the debugger, filters and records requests, and saves state. |
| `popup.html` / `popup.js` | Popup UI and Markdown formatting. |
| `settings.js` | Default settings, shared by the service worker and the popup. |

There is no build step. Edit the files, then click the reload button for the extension on `chrome://extensions`.

## License

[MIT](LICENSE)
