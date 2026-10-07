/**
 * Offscreen document used purely to write to the clipboard. A service worker has no DOM,
 * and the captured page may be long gone from user activation by the time we finish.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'copy') return;
  const ta = document.getElementById('buf') as HTMLTextAreaElement;
  ta.value = String(msg.text ?? '');
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.value = '';
  sendResponse({ ok });
});
