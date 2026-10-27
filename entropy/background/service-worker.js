/**
 * ENTROPY — Background Service Worker (background/service-worker.js)
 *
 * Automatically escalates the decay stage over time so the user doesn't
 * have to manually click — the page just gets worse the longer they stay.
 *
 * Architecture:
 *   chrome.tabs.onActivated / onUpdated → detect when user lands on a watched site
 *   chrome.alarms                       → fire every STAGE_INTERVAL_MINUTES
 *   chrome.scripting.executeScript      → apply the next stage class to the tab's <body>
 *   chrome.scripting.insertCSS          → ensure decay.css is injected first
 *
 * Manifest V3 permissions required (already added to manifest.json):
 *   "alarms", "tabs", "scripting", "activeTab"
 *
 * Reset: calling resetEntropyDecay() from the popup (or alarm cleanup) is still clean —
 * it removes every class Entropy has added without touching innerHTML.
 */

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

/** Minutes between automatic stage escalations (adjust to taste) */
const STAGE_INTERVAL_MINUTES = 2;

/** Maximum stage before auto-progression stops */
const MAX_STAGE = 3;

/**
 * Hostnames that trigger auto-decay.
 * Match against tab.url using URL().hostname.
 */
const WATCHED_HOSTNAMES = [
  'twitter.com',
  'x.com',
  'reddit.com',
  'www.reddit.com',
  'youtube.com',
  'www.youtube.com',
  'instagram.com',
  'www.instagram.com',
  'tiktok.com',
  'www.tiktok.com',
];

/** Prefix used for all alarm names so we can distinguish ours */
const ALARM_PREFIX = 'entropy-decay-tab-';

// ── In-memory state ───────────────────────────────────────────────────────────
// Note: service workers are ephemeral — state is also persisted in chrome.storage.session
// so it survives worker restarts within the same browser session.

/** Map of tabId → current decay stage (1-3, or 0 = not active) */
let tabStages = {};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if the given URL's hostname is in the watch list.
 * @param {string} url
 * @returns {boolean}
 */
function isWatchedSite(url) {
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
    return false;
  }
  try {
    const hostname = new URL(url).hostname;
    return WATCHED_HOSTNAMES.includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Persist tabStages to session storage so state survives service-worker restarts.
 */
async function persistState() {
  await chrome.storage.session.set({ entropyTabStages: tabStages });
}

/**
 * Restore tabStages from session storage on worker startup.
 */
async function restoreState() {
  const data = await chrome.storage.session.get('entropyTabStages');
  if (data.entropyTabStages) {
    tabStages = data.entropyTabStages;
  }
}

// ── Decay application ─────────────────────────────────────────────────────────

/**
 * Injects decay.css if not already present, then applies the given stage class
 * to the tab's <body>. Never touches innerHTML — only classList.
 *
 * @param {number} tabId
 * @param {number} stage - 1, 2, or 3
 */
async function applyDecayToTab(tabId, stage) {
  try {
    // Ensure the stylesheet is injected (idempotent — Chrome deduplicates)
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/decay.css']
    });

    // Toggle body classes — reversible, never touches innerHTML
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (selectedStage) => {
        document.body.classList.add('entropy-decay-active');
        document.body.classList.remove('entropy-stage-1', 'entropy-stage-2', 'entropy-stage-3');
        document.body.classList.add(`entropy-stage-${selectedStage}`);
      },
      args: [stage]
    });

    tabStages[tabId] = stage;
    await persistState();
    console.log(`[Entropy] Tab ${tabId} → Stage ${stage}`);
  } catch (err) {
    // Tab may have navigated away or been closed — clean up silently
    console.warn(`[Entropy] Could not apply decay to tab ${tabId}:`, err.message);
    await cleanupTab(tabId);
  }
}

/**
 * Removes all decay classes and CSS from the given tab.
 * Safe to call multiple times — idempotent.
 *
 * @param {number} tabId
 */
async function resetDecayOnTab(tabId) {
  try {
    await chrome.scripting.removeCSS({
      target: { tabId },
      files: ['content/decay.css']
    });
  } catch {
    // CSS may not have been injected yet — ignore
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        document.body.classList.remove(
          'entropy-decay-active',
          'entropy-stage-1',
          'entropy-stage-2',
          'entropy-stage-3'
        );
      }
    });
  } catch {
    // Tab gone — ignore
  }
}

/**
 * Cancel a tab's alarm and remove it from state.
 * @param {number} tabId
 */
async function cleanupTab(tabId) {
  await chrome.alarms.clear(`${ALARM_PREFIX}${tabId}`);
  delete tabStages[tabId];
  await persistState();
}

// ── Session start / site detection ───────────────────────────────────────────

/**
 * Called when the user navigates to or focuses a watched site.
 * Starts a fresh auto-progression alarm for the tab.
 *
 * @param {number} tabId
 */
async function startDecaySession(tabId) {
  // Reset any existing state for this tab
  await cleanupTab(tabId);

  // Stage 1 fires immediately
  await applyDecayToTab(tabId, 1);

  // Create a periodic alarm that escalates every STAGE_INTERVAL_MINUTES
  chrome.alarms.create(`${ALARM_PREFIX}${tabId}`, {
    delayInMinutes: STAGE_INTERVAL_MINUTES,
    periodInMinutes: STAGE_INTERVAL_MINUTES
  });

  console.log(`[Entropy] Started auto-decay session for tab ${tabId}`);
}

// ── Alarm handler — the escalation engine ────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;

  const tabId = parseInt(alarm.name.replace(ALARM_PREFIX, ''), 10);
  const currentStage = tabStages[tabId] || 1;
  const nextStage = currentStage + 1;

  if (nextStage > MAX_STAGE) {
    // Already at max — stop the alarm, leave the decay in place
    console.log(`[Entropy] Tab ${tabId} reached MAX_STAGE (${MAX_STAGE}). Alarm stopped.`);
    await chrome.alarms.clear(alarm.name);
    return;
  }

  // Verify the tab still exists and is on a watched site
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !isWatchedSite(tab.url)) {
      await cleanupTab(tabId);
      return;
    }
    await applyDecayToTab(tabId, nextStage);
  } catch {
    // Tab was closed
    await cleanupTab(tabId);
  }
});

// ── Tab event listeners ───────────────────────────────────────────────────────

/**
 * User navigated to a new URL in an existing tab.
 * Start a session if it's a watched site; clean up if they navigated away.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only act when navigation is complete
  if (changeInfo.status !== 'complete') return;

  if (isWatchedSite(tab.url)) {
    await startDecaySession(tabId);
  } else if (tabStages[tabId] !== undefined) {
    // User navigated away from a watched site — clean up without resetting DOM
    // (the page is gone anyway on navigation)
    await cleanupTab(tabId);
  }
});

/**
 * User switched to an existing tab.
 * If the tab is on a watched site and has no active session, start one.
 */
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url) return;

    if (isWatchedSite(tab.url) && tabStages[tabId] === undefined) {
      await startDecaySession(tabId);
    }
  } catch (err) {
    console.warn('[Entropy] onActivated error:', err.message);
  }
});

/**
 * Tab was closed — cancel its alarm and clean state.
 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabStages[tabId] !== undefined) {
    await cleanupTab(tabId);
    console.log(`[Entropy] Tab ${tabId} closed — cleaned up.`);
  }
});

// ── Message handler — allow popup to trigger reset via service worker ─────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'RESET_TAB_DECAY') {
    const tabId = request.tabId;
    resetDecayOnTab(tabId)
      .then(() => cleanupTab(tabId))
      .then(() => sendResponse({ status: 'reset' }))
      .catch((err) => sendResponse({ status: 'error', message: err.message }));
    return true; // keep channel open for async response
  }

  if (request.action === 'GET_TAB_STAGE') {
    sendResponse({ stage: tabStages[request.tabId] || 0 });
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────

// Restore state when the service worker wakes up after being suspended
restoreState().then(() => {
  console.log('[Entropy] Service worker started. Restored state:', tabStages);
});

