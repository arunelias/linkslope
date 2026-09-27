/**
 * @file Opens the scanner in an extension tab when the toolbar action is clicked.
 * Scanning and email sending live in that tab; this worker does not own their state.
 */
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});
