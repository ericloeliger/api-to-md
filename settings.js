// Shared by the service worker (via importScripts) and the popup.
const DEFAULT_SETTINGS = {
  excludeMixpanel: true,
  excludeChurnZero: true,
  excludeDatadog: true,
  includeHeaders: true
};
