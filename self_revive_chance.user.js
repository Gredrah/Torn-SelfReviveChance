// ==UserScript==
// @name         Dragon's Heart Monitor
// @author       Gredrah
// @namespace    https://www.github.com/gredrah/
//
// @version      1.0.0
// @description  Provides Torn players with a quick way to check their revive chance against different skill levels of reviver. Accessed via the Hospital page.
// @match        https://www.torn.com/hospitalview.php
// @license      UNLICENSE
//
// @grant GM_xmlhttpRequest
// @grant GM_getValue
// @grant GM_setValue
// ==/UserScript==

// util/util.js
const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const SECONDS_PER_DAY = 86_400;
const DEBUG_LOGGING = true;

function debugLog(...args) {
  if (!DEBUG_LOGGING) {
    return;
  }
  console.log('[Dragon\'s Heart Monitor]', ...args);
}

function toTimestampBigInt(value, label) {
	if (typeof value === 'bigint') {
		return value;
	}

	if (typeof value === 'number' && Number.isFinite(value)) {
		return BigInt(Math.trunc(value));
	}

	if (typeof value === 'string' && value.trim()) {
		return BigInt(value.trim());
	}

	throw new TypeError(`Invalid ${label}. Expected a Unix timestamp.`);
}

function getNanosecondsSinceTimestamp(currentTimestampSeconds, earlierTimestampSeconds) {
	const currentTimestamp = toTimestampBigInt(currentTimestampSeconds, 'current timestamp');
  const earlierTimestamp = toTimestampBigInt(earlierTimestampSeconds, 'earlier timestamp');

  if (currentTimestamp <= earlierTimestamp) {
		return 0n;
	}

  return (currentTimestamp - earlierTimestamp) * NANOSECONDS_PER_SECOND;
}

function getReviveAgeNanoseconds(reviveTimestampSeconds, currentTimestampSeconds) {
	return getNanosecondsSinceTimestamp(currentTimestampSeconds, reviveTimestampSeconds);
}

function getFromTimestampForLastHours(currentTimestampSeconds, lookbackHours = 24) {
	const currentTimestamp = toTimestampBigInt(currentTimestampSeconds, 'current timestamp');
  const offsetSeconds = BigInt(lookbackHours) * 60n * 60n;

	if (currentTimestamp <= offsetSeconds) {
		return 0n;
	}

	return currentTimestamp - offsetSeconds;
}

function annotateRevivesWithAgeNanoseconds(revives, currentTimestampSeconds) {
	if (!Array.isArray(revives)) {
		throw new TypeError('Expected revives to be an array.');
	}

	return revives.map((revive) => ({
		...revive,
		timeSinceReviveNs: getReviveAgeNanoseconds(revive?.timestamp, currentTimestampSeconds),
	}));
}
//
// util/api.js
async function requestJson(url) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      responseType: 'text',
      onload: (response) => {
        try {
          resolve(JSON.parse(response.responseText));
        } catch (error) {
          reject(error);
        }
      },
      onerror: () => reject(new Error('Request failed')),
      ontimeout: () => reject(new Error('Request timed out')),
    });
  });
}

async function isValidApiKey(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    return false;
  }

  try {
    const url =
      `https://api.torn.com/user/?selections=basic&key=${encodeURIComponent(apiKey.trim())}`;
    const data = await requestJson(url);

    return data?.error === undefined || data?.error === 0 || data?.error === '0';
  } catch {
    return false;
  }
}

function formatNumber(value) {
  return Number(value).toLocaleString();
}

async function getCurrentTimestamp(apiKey) {
  debugLog('Requesting current timestamp (public v2 endpoint).');
  const publicResponse = await requestJson('https://api.torn.com/v2/torn/timestamp');
  debugLog('Timestamp public response:', publicResponse);
  if (Number.isFinite(Number(publicResponse?.timestamp))) {
    debugLog('Timestamp accepted from public endpoint:', publicResponse.timestamp);
    return publicResponse;
  }

  const publicError = publicResponse?.error;
  const isKeyRelatedPublicError =
    typeof publicError?.error === 'string' &&
    /incorrect key|key/i.test(publicError.error);

  if (!apiKey || !isKeyRelatedPublicError) {
    debugLog('Timestamp fallback not attempted.', {
      hasApiKey: Boolean(apiKey),
      isKeyRelatedPublicError,
    });
    return publicResponse;
  }

  // Some Torn environments may require a key even on v2 timestamp.
  const keyedResponse = await requestJson(
    `https://api.torn.com/v2/torn/timestamp?key=${encodeURIComponent(apiKey)}`
  );
  debugLog('Timestamp keyed fallback response:', keyedResponse);
  return keyedResponse;
}
//
// util/revives.js
async function fetchRevives(apiKey, fromUnixSeconds = 0) {
  const params = new URLSearchParams({
    key: apiKey,
    filters: 'incoming',
  });
  if (fromUnixSeconds > 0) {
    params.set('from', String(fromUnixSeconds));
  }

  const url = `https://api.torn.com/v2/user/revivesFull?${params.toString()}`;

  debugLog('Requesting revives with URL:', url);
  const data = await requestJson(url);

  if (data?.error) {
    debugLog('Revives API error response:', data.error);
    throw new Error(`Failed to retrieve revives: ${data.error.error || 'Unknown API error'}`);
  }

  const revivesPayload = data?.revives ?? data?.revivesFull ?? data?.revivesfull;
  let revivesArray = [];
  if (Array.isArray(revivesPayload)) {
    revivesArray = revivesPayload;
  } else if (revivesPayload && typeof revivesPayload === 'object') {
    revivesArray = Object.values(revivesPayload);
  }

  debugLog('Revives retrieved:', {
    count: revivesArray.length,
    sample: revivesArray.slice(0, 3).map((revive) => ({
      id: revive?.id,
      timestamp: revive?.timestamp,
      result: revive?.result,
    })),
  });

  return revivesArray;
}
//

(function() {
    'use strict';

    const API_KEY_STORAGE_KEY = "monitor_api_key";
    const API_KEY_URL = "https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Dragon's Heart Monitor&user=basic,revivesfull";
    
    const getStoredApiKey = () => GM_getValue(API_KEY_STORAGE_KEY, null);

    const generateApiKey = () => {
        window.open(API_KEY_URL, "_blank", "noopener,noreferrer");
    };

    const checkReviveChance = async (apiKey) => {
        // Throw up a dialogue to enter revive skill, leave blank to assume 100.
        let reviveSkillInput = prompt("Enter the reviver's skill level (1-100). Leave blank to assume 100.");

      if (reviveSkillInput === null) {
        return;
      }

        let reviveSkill = 100.00; // Default to 100 if input is blank or invalid

      if (reviveSkillInput.trim() !== "") {
            reviveSkill = Number.parseFloat(reviveSkillInput);
            if (Number.isNaN(reviveSkill) || reviveSkill < 0 || reviveSkill > 100) {
                alert("Invalid revive skill level. Please enter a number between 1 and 100.");
                return;
            }
        }

        try {
          debugLog('Starting revive chance check.', { reviveSkill });
            const currentTimestampResponse = await getCurrentTimestamp(apiKey);
            const currentTimestampSeconds = Number(currentTimestampResponse?.timestamp);

          if (!Number.isFinite(currentTimestampSeconds) || currentTimestampSeconds <= 0) {
            console.error('Unexpected timestamp response:', currentTimestampResponse);
            const apiErrorText = currentTimestampResponse?.error?.error;
            if (typeof apiErrorText === 'string' && apiErrorText.length > 0) {
              alert(`Failed to retrieve Torn timestamp: ${apiErrorText}`);
              return;
            }
              alert("Failed to retrieve the current Torn timestamp.");
                return;
            }

          debugLog('Current timestamp validated:', currentTimestampSeconds);

          const twentyFourHoursAgoTimestamp = getFromTimestampForLastHours(currentTimestampSeconds, 24);
          debugLog('24h cutoff timestamp computed:', twentyFourHoursAgoTimestamp.toString());
          const revives = await fetchRevives(apiKey, twentyFourHoursAgoTimestamp);
          debugLog('Revives array length after fetch:', revives.length);

            const annotatedRevives = annotateRevivesWithAgeNanoseconds(revives, currentTimestampSeconds);
            const nanoTimeReviveArray = annotatedRevives.map((revive) => revive.timeSinceReviveNs);
            debugLog('Revive age (ns) sample:', nanoTimeReviveArray.slice(0, 5).map((value) => value.toString()));
            
            const scoreTotal = nanoTimeReviveArray.reduce((total, elapsedNs) => {
              const elapsedSeconds = Number(elapsedNs) / Number(NANOSECONDS_PER_SECOND);
              return total + (1 - (elapsedSeconds / SECONDS_PER_DAY));
            }, 0);

            debugLog('Score computed:', {
              scoreTotal,
              reviveCount: nanoTimeReviveArray.length,
            });

            const reviveChance = 90 + (reviveSkill / 10) - scoreTotal * (8 - (reviveSkill / 25));
            debugLog('Revive chance computed:', { reviveSkill, reviveChance });

            alert(`Your current revive chance is approximately: ${reviveChance.toFixed(2)}%\n\nThis is based on your recent revives in the last 24 hours and the reviver's skill level you provided: ${reviveSkill}.`);

        } catch (error) {
            console.error("Error checking timestamp: ", error);
        }


    }
        
    const handleMonitorButtonClick = async () => {
        let apiKey = getStoredApiKey();

        if (!apiKey || !(await isValidApiKey(apiKey))) {
            const entry = prompt(
                "Click OK to generate an API key with basic, revivesFull permissions, then paste it here.\n" +
                "If you already have a valid API key (ex. Limited) that you want to use, paste it here and press OK."
            );

            if (entry === null) {
                return;
            }

            if (!entry.trim()) {
                generateApiKey();

                const waitForReturnThenPrompt = () => {
                    const askForKey = async () => {
                        const newKey = prompt(
                            'Enter your newly generated "Dragon Heart Monitor" key and click OK:'
                        );

                        if (!newKey?.trim()) return;

                        const apiKey = newKey.trim();
                        if (!(await isValidApiKey(apiKey))) {
                            alert("That API key is invalid.");
                            return;
                        }

                        GM_setValue(API_KEY_STORAGE_KEY, apiKey);
                        await checkReviveChance(apiKey);
                    };

                    const onFocus = async () => {
                        window.removeEventListener('focus', onFocus);
                        await askForKey();
                    };

                    window.addEventListener('focus', onFocus);
                };

                return waitForReturnThenPrompt();
            }

            apiKey = entry.trim();
            if (!(await isValidApiKey(apiKey))) {
                alert("That API key is invalid.");
                return;
            }

            GM_setValue(API_KEY_STORAGE_KEY, apiKey);
        }

        return await checkReviveChance(apiKey);
    };

    const addMonitorButton = () => {
        const linksWrap = document.querySelector('.content-title-links');
        if (!linksWrap) return;

        let button = linksWrap.querySelector('#dragon-heart-monitor-btn');
        if (button) return;

        button = document.createElement('button');
        button.id = 'dragon-heart-monitor-btn';
        button.type = 'button';
        button.setAttribute('aria-label', 'Check revive chance');

        const setButtonLabel = () => {
            const mobile = window.matchMedia('(max-width: 768px)').matches;
            button.textContent = mobile ? '🐲' : '🐲Check Revive Chance🐲';
        };

        setButtonLabel();
        window.addEventListener('resize', setButtonLabel);

        const redBase = 'rgba(231, 71, 71, 0.66)';

        button.style.cssText = `
            display: inline-flex;
            align-items: center;
            justify-content: center;
            height: 24px;
            line-height: 1;
            padding: 0 10px;
            margin-left: 0;
            border: 1px solid rgba(255,255,255,0.18);
            border-radius: 4px;
            background: ${redBase};
            color: #fff;
            font-weight: 700;
            font-size: 12px;
            cursor: pointer;
            white-space: nowrap;
            transition: background 0.15s ease;
        `;

        button.style.cssFloat = 'left';
        button.style.clear = 'left';
        button.style.marginRight = '8px';

        button.addEventListener('mouseenter', () => {
            button.style.background = 'rgba(210, 45, 45, 0.8)';
        });

        button.addEventListener('mouseleave', () => {
            button.style.background = redBase;
        });

        button.addEventListener('click', handleMonitorButtonClick);

        linksWrap.insertBefore(button, linksWrap.firstChild);
    };

    addMonitorButton();
})();

