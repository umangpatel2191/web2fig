# Web2Fig — Privacy Policy

Web2Fig (Chrome extension "Web2Fig Capture" and the Figma plugin "Web2Fig") works entirely on your device.

**What it reads:** only the page you choose to capture, when you click the extension icon, use its shortcut, or pick an element:
the page's layout, text, styles and images.

**Where it goes:** to your clipboard (or a .json file you download), and from there into your own Figma file.
Nothing is sent to us or to any third party. Web2Fig has no servers, no accounts, no analytics and no tracking.

**Stored locally:** your capture settings and your last capture (in the extension's local storage on your computer) so you can copy it again.
You can remove it by uninstalling the extension.

**Network:** to include images, the extension downloads the images that the captured page itself uses, from the page's own servers.

**Link mode (optional, in the Figma plugin):** if you paste a website address into the plugin's "From a link" tab, that address and your capture options (size, scroll setting) are sent to the Web2Fig server, hosted on Hugging Face Spaces. The server opens the page in a temporary browser, converts it to layers, sends the result back to the plugin and then discards it. Pages and results are not stored or logged by us. To prevent abuse the server briefly keeps your connection's address in memory (not on disk) to apply a per-hour limit. No Figma file content is ever sent. Pasting a capture made with the browser extension never contacts any server.

**Permissions and why:**
- `<all_urls>` (host access): download the captured page's images, which are often on other domains.
- `activeTab`, `scripting`: read the page you are capturing.
- `storage`: remember your settings and last capture.
- `clipboardWrite`, `offscreen`: copy the capture to your clipboard.

Contact: umangp737@gmail.com
