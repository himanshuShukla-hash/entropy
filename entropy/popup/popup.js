/**
 * ENTROPY — POPUP CONTROLLER (popup/popup.js)
 *
 * Demonstrates Chrome Manifest V3 APIs:
 * - chrome.tabs.query: Finds the currently active browser tab
 * - chrome.scripting.insertCSS: Injects extension-owned CSS rules into the page
 * - chrome.scripting.removeCSS: Safely removes extension CSS rules
 * - chrome.scripting.executeScript: Runs reversible DOM class manipulation
 *
 * New in this version:
 * - Intensity slider: maps 1 (Mild) → 2 (Medium) → 3 (Hardcore)
 *   "Apply Decay" reads the slider so you pick intensity before firing.
 */

document.addEventListener('DOMContentLoaded', () => {
  const btnApplyDecay    = document.getElementById('btn-apply-decay');
  const btnReset         = document.getElementById('btn-reset');
  const btnStage1        = document.getElementById('btn-stage-1');
  const btnStage2        = document.getElementById('btn-stage-2');
  const btnStage3        = document.getElementById('btn-stage-3');
  const popupStatus      = document.getElementById('popup-status');
  const statusMessage    = document.getElementById('status-message');
  const intensitySlider  = document.getElementById('intensity-slider');
  const sliderValueLabel = document.getElementById('slider-value-label');

  /** Human-readable labels for each slider position */
  const STAGE_LABELS = {
    1: '1 — Mild',
    2: '2 — Medium',
    3: '3 — Hardcore'
  };

  /** CSS class names for the badge colour by intensity */
  const STAGE_BADGE_CLASS = {
    1: 'mild',
    2: 'medium',
    3: 'hardcore'
  };

  /**
   * Sync the badge label + colour whenever the slider moves.
   * This is pure UI — no tab interaction.
   */
  function updateSliderUI(value) {
    const stage = parseInt(value, 10);
    sliderValueLabel.textContent = STAGE_LABELS[stage];
    sliderValueLabel.className   = `slider-value-badge ${STAGE_BADGE_CLASS[stage]}`;
  }

  // Wire the live preview on drag
  intensitySlider.addEventListener('input', (e) => updateSliderUI(e.target.value));

  // Initialise label on load
  updateSliderUI(intensitySlider.value);

  /**
   * Helper: Get the currently active tab in the focused window.
   */
  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  /**
   * Check if a tab URL is supported.
   * Cannot inject scripts into chrome:// or chrome-extension:// pages.
   */
  function isRestrictedUrl(url) {
    return (
      !url ||
      url.startsWith('chrome://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('edge://')
    );
  }

  /**
   * Applies decay CSS and classes to the active page.
   * @param {number} stage - 1 (Mild), 2 (Medium), or 3 (Hardcore)
   */
  async function applyDecay(stage = 1) {
    try {
      const tab = await getActiveTab();
      if (!tab || !tab.id) {
        statusMessage.textContent = 'Error: No active tab found.';
        return;
      }

      if (isRestrictedUrl(tab.url)) {
        statusMessage.textContent = 'Chrome blocks extensions on internal chrome:// pages.';
        return;
      }

      // Step 1: Inject the decay stylesheet
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content/decay.css']
      });

      // Step 2: Add decay classes to <body> — only classList, never innerHTML
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (selectedStage) => {
          document.body.classList.add('entropy-decay-active');
          document.body.classList.remove('entropy-stage-1', 'entropy-stage-2', 'entropy-stage-3');
          document.body.classList.add(`entropy-stage-${selectedStage}`);
        },
        args: [stage]
      });

      // Update popup UI
      const label = STAGE_LABELS[stage] || `Stage ${stage}`;
      popupStatus.textContent = `Stage ${stage}`;
      popupStatus.className = 'status-pill decayed';
      statusMessage.textContent = `Decay applied — ${label}.`;
    } catch (err) {
      console.error(err);
      statusMessage.textContent = `Error: ${err.message}`;
    }
  }

  /**
   * Completely removes decay effects and restores original page appearance.
   * Guaranteed to be clean — removes every class Entropy may have set.
   */
  async function resetPage() {
    try {
      const tab = await getActiveTab();
      if (!tab || !tab.id) return;

      if (isRestrictedUrl(tab.url)) {
        statusMessage.textContent = 'Cannot modify internal chrome:// pages.';
        return;
      }

      // Step 1: Remove injected CSS
      try {
        await chrome.scripting.removeCSS({
          target: { tabId: tab.id },
          files: ['content/decay.css']
        });
      } catch (cssErr) {
        // Ignore if CSS was not currently inserted
      }

      // Step 2: Remove all decay classes from <body>
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          document.body.classList.remove(
            'entropy-decay-active',
            'entropy-stage-1',
            'entropy-stage-2',
            'entropy-stage-3',
            'decay-stage-1',
            'decay-stage-2',
            'decay-stage-3'
          );
        }
      });

      // Update popup UI
      popupStatus.textContent = 'Normal';
      popupStatus.className = 'status-pill normal';
      statusMessage.textContent = 'Page reset cleanly. All decay removed.';
    } catch (err) {
      console.error(err);
      statusMessage.textContent = `Error: ${err.message}`;
    }
  }

  /**
   * Check initial page decay state when popup opens.
   * Reflects reality in case a service worker already applied decay.
   */
  async function checkInitialStatus() {
    try {
      const tab = await getActiveTab();
      if (!tab || isRestrictedUrl(tab.url)) return;

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.body.classList.contains('entropy-decay-active')
      });

      const isDecayed = results && results[0] && results[0].result;
      if (isDecayed) {
        popupStatus.textContent = 'Decayed';
        popupStatus.className = 'status-pill decayed';
        statusMessage.textContent = 'Active tab currently has decay applied.';
      } else {
        popupStatus.textContent = 'Normal';
        popupStatus.className = 'status-pill normal';
        statusMessage.textContent = 'Active tab is normal.';
      }
    } catch (err) {
      // Ignored if permissions not yet active
    }
  }

  // ── Event Listeners ──────────────────────────────────────────────────────────

  // "Apply Decay" reads the current slider value
  btnApplyDecay.addEventListener('click', () => {
    const stage = parseInt(intensitySlider.value, 10);
    applyDecay(stage);
  });

  btnReset.addEventListener('click', resetPage);

  // Stage chip buttons also sync the slider to match
  btnStage1.addEventListener('click', () => {
    intensitySlider.value = '1';
    updateSliderUI('1');
    applyDecay(1);
  });
  btnStage2.addEventListener('click', () => {
    intensitySlider.value = '2';
    updateSliderUI('2');
    applyDecay(2);
  });
  btnStage3.addEventListener('click', () => {
    intensitySlider.value = '3';
    updateSliderUI('3');
    applyDecay(3);
  });

  // Initialize
  checkInitialStatus();
});
