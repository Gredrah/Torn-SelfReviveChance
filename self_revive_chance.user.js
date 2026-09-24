// ==UserScript==
// @name         Dragon's Heart Monitor
// @author       Gredrah
// @namespace    https://www.github.com/gredrah/
//
// @version      1.1.4
// @description  Provides Torn players with a quick way to check their revive chance against different skill levels of reviver. Accessed via the Hospital page. Also collects and stores the last known revive chance for all players, and the incoming revive log of participants in a Cloudflare Worker database, which can be used to estimate the current revive chance of a target player.
// @match        https://www.torn.com/hospitalview.php*
// @match        https://www.torn.com/profiles.php*
// @license      UNLICENSE
//
// @grant GM_xmlhttpRequest
// @grant GM_getValue
// @grant GM_setValue
// @grant GM_registerMenuCommand
// @grant GM_deleteValue
// @connect revives.api.gredra.com
// @connect api.torn.com
// ==/UserScript==

// util/util.js
const SECONDS_PER_DAY = 86400;
const DEBUG_LOGGING = true;

function debugLog(...args) {
    if (!DEBUG_LOGGING) return;
    console.log('[Dragon\'s Heart Monitor]', ...args);
}

function getElapsedSeconds(currentTimestamp, earlierTimestamp) {
    if (!currentTimestamp || !earlierTimestamp || currentTimestamp <= earlierTimestamp) return 0;
    return currentTimestamp - earlierTimestamp;
}

function getFromTimestampForLastHours(currentTimestamp, lookbackHours = 24) {
    const offsetSeconds = lookbackHours * 3600;
    return Math.max(0, currentTimestamp - offsetSeconds);
}

function annotateRevivesWithAge(revives, currentTimestamp) {
    if (!Array.isArray(revives)) throw new TypeError('Expected revives to be an array.');
    return revives.map((revive) => ({
        ...revive,
        elapsedSeconds: getElapsedSeconds(currentTimestamp, revive?.timestamp),
    }));
}

async function getSkillLevels(apiKey) {
    const url = `https://api.torn.com/v2/user/?selections=skills&key=${encodeURIComponent(apiKey)}`;
    const data = await requestJson(url);
    if (data?.error) throw new Error(`Torn API error: ${JSON.stringify(data.error)}`);

    const skills = data.skills;
    if (!Array.isArray(skills)) throw new Error("Failed to retrieve skills from API response.");

    debugLog('Torn API: getSkillLevels | Total Skills Fetched:', skills.length);
    return skills;
}

function getSkillLevel(skills, skillName) {
    if (!skills || !Array.isArray(skills)) throw new TypeError("Invalid skills object. Expected an array.");
    const skill = skills.find(s => s.slug === skillName.toLowerCase() || (s.name && s.name.toLowerCase() === skillName.toLowerCase()));
    if (!skill) throw new Error(`Skill "${skillName}" not found in skills object.`);
    debugLog('Local: getSkillLevel | Extracted Skill:', skill.level);
    return skill.level;
}

// util/api.js
async function requestJson(url) {
    // Strips the API key from the URL for cleaner console logging
    const safeUrl = url.split('&key=')[0].split('?key=')[0]; 
    
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'GET',
            url,
            responseType: 'text',
            onload: (response) => {
                debugLog(`Network: GET ${safeUrl} | Status:`, response.status);
                try { resolve(JSON.parse(response.responseText)); } 
                catch (error) { reject(error); }
            },
            onerror: () => {
                debugLog(`Network: GET ${safeUrl} | Status: FAILED`);
                reject(new Error('Request failed'));
            },
            ontimeout: () => {
                debugLog(`Network: GET ${safeUrl} | Status: TIMEOUT`);
                reject(new Error('Request timed out'));
            }
        });
    });
}

async function isValidApiKey(apiKey) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) return false;
    try {
        const url = `https://api.torn.com/user/?selections=basic&key=${encodeURIComponent(apiKey.trim())}`;
        const data = await requestJson(url);
        const isValid = data?.error === undefined || data?.error === 0 || data?.error === '0';
        debugLog('Torn API: isValidApiKey | Result:', isValid);
        return isValid;
    } catch {
        return false;
    }
}

async function getCurrentTimestamp(apiKey) {
    let response = await requestJson('https://api.torn.com/v2/torn/timestamp');
    
    const isKeyRelatedPublicError = typeof response?.error?.error === 'string' && /incorrect key|key/i.test(response.error.error);

    if (apiKey && isKeyRelatedPublicError) {
        response = await requestJson(`https://api.torn.com/v2/torn/timestamp?key=${encodeURIComponent(apiKey)}`);
    }

    debugLog('Torn API: getCurrentTimestamp | Time:', response?.timestamp || 'Failed');
    return response;
}

// util/revives.js
async function fetchRevives(apiKey, fromUnixSeconds = 0) {
    const params = new URLSearchParams({ key: apiKey, filters: 'incoming' });
    if (fromUnixSeconds > 0) params.set('from', String(fromUnixSeconds));

    const url = `https://api.torn.com/v2/user/revivesFull?${params.toString()}`;
    const data = await requestJson(url);

    if (data?.error) throw new Error(`Failed to retrieve revives: ${data.error.error || 'Unknown API error'}`);

    const revivesPayload = data?.revives ?? data?.revivesFull ?? data?.revivesfull;
    let revivesArray = [];
    if (Array.isArray(revivesPayload)) revivesArray = revivesPayload;
    else if (revivesPayload && typeof revivesPayload === 'object') revivesArray = Object.values(revivesPayload);
    
    debugLog('Torn API: fetchRevives | Revives Found:', revivesArray.length);
    return revivesArray;
}

(function() {
    'use strict';

    const API_STORAGE_KEY = "monitor_api_key";
    const SKILL_STORAGE_KEY = "monitor_revive_skill";
    const REVIVES_FULL_LAST_PUSH_TS_KEY = "monitor_revives_full_last_push_ts";
    const PASSIVE_LAST_RUN_TS_KEY = "monitor_passive_last_run_ts";
    const PASSIVE_INTERVAL_MINUTES_KEY = "monitor_passive_interval_minutes";
    const API_KEY_URL = "https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Dragon's Heart Monitor&user=basic,revivesfull,skills";
    const CLOUDFLARE_API_URL = "https://revives.api.gredra.com";
    const PASSIVE_INTERVAL_OPTIONS_MINUTES = [15, 30, 45, 60];
    const DEFAULT_PASSIVE_INTERVAL_MINUTES = 60;
    const PASSIVE_COLLECTION_OVERLAP_SECONDS = 300;
    
    let lastSubmittedData = ""; 

    const getStoredApiKey = () => GM_getValue(API_STORAGE_KEY, null);
    const generateApiKey = () => window.open(API_KEY_URL, "_blank", "noopener,noreferrer");

    const clearStoredApiKey = () => {
    GM_deleteValue(API_STORAGE_KEY);
    alert("Stored API key cleared.");
    };

    const clearStoredSkill = () => {
        GM_deleteValue(SKILL_STORAGE_KEY);
        alert("Stored revive skill cleared.");
    };

    const clearAllStoredData = () => {
        GM_deleteValue(API_STORAGE_KEY);
        GM_deleteValue(SKILL_STORAGE_KEY);
        GM_deleteValue(REVIVES_FULL_LAST_PUSH_TS_KEY);
        GM_deleteValue(PASSIVE_LAST_RUN_TS_KEY);
        GM_deleteValue(PASSIVE_INTERVAL_MINUTES_KEY);
        alert("Stored API key and revive skill cleared.");
    };

    GM_registerMenuCommand("Clear stored API key", clearStoredApiKey);
    GM_registerMenuCommand("Clear stored revive skill", clearStoredSkill);
    GM_registerMenuCommand("Clear all Dragon's Heart Monitor data", clearAllStoredData);

    const getStoredLastRevivesFullPushTimestamp = () => Number(GM_getValue(REVIVES_FULL_LAST_PUSH_TS_KEY, 0)) || 0;
    const setStoredLastRevivesFullPushTimestamp = (timestamp) => {
        const parsedTimestamp = Number(timestamp);
        if (Number.isFinite(parsedTimestamp) && parsedTimestamp > 0) {
            GM_setValue(REVIVES_FULL_LAST_PUSH_TS_KEY, parsedTimestamp);
        }
    };
    const getStoredLastPassiveRunTimestamp = () => Number(GM_getValue(PASSIVE_LAST_RUN_TS_KEY, 0)) || 0;
    const setStoredLastPassiveRunTimestamp = (timestamp) => {
        const parsedTimestamp = Number(timestamp);
        if (Number.isFinite(parsedTimestamp) && parsedTimestamp > 0) {
            GM_setValue(PASSIVE_LAST_RUN_TS_KEY, parsedTimestamp);
        }
    };

    const getStoredPassiveIntervalMinutes = () => {
        const value = Number(GM_getValue(PASSIVE_INTERVAL_MINUTES_KEY, DEFAULT_PASSIVE_INTERVAL_MINUTES));
        return PASSIVE_INTERVAL_OPTIONS_MINUTES.includes(value)
            ? value
            : DEFAULT_PASSIVE_INTERVAL_MINUTES;
    };

    const setStoredPassiveIntervalMinutes = (minutes) => {
        const parsedMinutes = Number(minutes);
        if (!PASSIVE_INTERVAL_OPTIONS_MINUTES.includes(parsedMinutes)) return false;
        GM_setValue(PASSIVE_INTERVAL_MINUTES_KEY, parsedMinutes);
        return true;
    };

    const shouldRunPassiveCollectionNow = (lastRunTimestamp, intervalMinutes, currentTimestampSeconds) => {
        const parsedIntervalMinutes = Number(intervalMinutes);
        const parsedLastRunTimestamp = Number(lastRunTimestamp);
        const parsedCurrentTimestampSeconds = Number(currentTimestampSeconds);

        if (!Number.isFinite(parsedIntervalMinutes) || parsedIntervalMinutes <= 0) return false;
        if (!Number.isFinite(parsedCurrentTimestampSeconds) || parsedCurrentTimestampSeconds <= 0) return false;

        if (!Number.isFinite(parsedLastRunTimestamp) || parsedLastRunTimestamp <= 0) return false;

        const intervalSeconds = parsedIntervalMinutes * 60;
        return parsedCurrentTimestampSeconds - parsedLastRunTimestamp >= intervalSeconds;
    };

    const promptForUserSkill = (storedSkill, promptText) => {
        const hasStoredSkill = Number.isFinite(storedSkill);
        const entry = hasStoredSkill
            ? prompt(promptText, String(storedSkill))
            : prompt(promptText);

        if (entry === null) return null;

        const trimmedEntry = entry.trim();
        if (!trimmedEntry) return hasStoredSkill ? storedSkill : 100;

        const parsedSkill = Number.parseFloat(trimmedEntry);
        if (Number.isNaN(parsedSkill) || parsedSkill < 0 || parsedSkill > 100) {
            alert('Invalid skill level.');
            return null;
        }

        GM_setValue(SKILL_STORAGE_KEY, parsedSkill);
        return parsedSkill;
    };

    const getStoredUserSkill = () => {
        const storedSkill = Number(GM_getValue(SKILL_STORAGE_KEY, null));
        return Number.isFinite(storedSkill) ? storedSkill : null;
    };

    const checkReviveChance = async (apiKey) => {
        let reviveSkillInput = prompt("Enter the reviver's skill level (1-100). Leave blank to assume 100.");
        if (reviveSkillInput === null) return;

        let reviveSkill = 100.00;
        if (reviveSkillInput.trim() !== "") {
            reviveSkill = Number.parseFloat(reviveSkillInput);
            if (Number.isNaN(reviveSkill) || reviveSkill < 0 || reviveSkill > 100) {
                alert("Invalid revive skill level. Please enter a number between 1 and 100.");
                return;
            }
        }

        try {
            const currentTimestampResponse = await getCurrentTimestamp(apiKey);
            const currentTimestampSeconds = Number(currentTimestampResponse?.timestamp);

            if (!Number.isFinite(currentTimestampSeconds) || currentTimestampSeconds <= 0) {
                alert("Failed to retrieve the current Torn timestamp.");
                return;
            }

            const twentyFourHoursAgoTimestamp = getFromTimestampForLastHours(currentTimestampSeconds, 24);
            const revives = await fetchRevives(apiKey, twentyFourHoursAgoTimestamp);
            void pushRevivesFullToWorker(apiKey, revives, currentTimestampSeconds);

            const annotatedRevives = annotateRevivesWithAge(revives, currentTimestampSeconds);
            
            const scoreTotal = annotatedRevives.reduce((total, revive) => {
                return total + (1 - (revive.elapsedSeconds / SECONDS_PER_DAY));
            }, 0);

            const reviveChance = 90 + (reviveSkill / 10) - scoreTotal * (8 - (reviveSkill / 25));

            debugLog('Local: checkReviveChance | Calculated Chance:', reviveChance.toFixed(2) + '%');
            alert(`Your current revive chance is approximately: ${reviveChance.toFixed(2)}%\n\nThis is based on your recent revives in the last 24 hours and the reviver's skill level you provided: ${reviveSkill}.`);

        } catch (error) {
            console.error("Error checking timestamp: ", error);
        }
    }
        
    const handleMonitorButtonClick = async () => {
        debugLog('Event: Monitor Button Clicked');
        let apiKey = getStoredApiKey();

        if (!apiKey || !(await isValidApiKey(apiKey))) {
            const entry = prompt(
                "Click OK to generate an API key with basic, revivesFull permissions, then paste it here.\n" +
                "If you already have a valid API key (ex. Limited) that you want to use, paste it here and press OK."
            );

            if (entry === null) return;

            if (!entry.trim()) {
                generateApiKey();
                const waitForReturnThenPrompt = () => {
                    const askForKey = async () => {
                        const newKey = prompt('Enter your newly generated "Dragon Heart Monitor" key and click OK:');
                        if (!newKey?.trim()) return;

                        const apiKey = newKey.trim();
                        if (!(await isValidApiKey(apiKey))) {
                            alert("That API key is invalid.");
                            return;
                        }
                        const reviveSkillLevel = getSkillLevel(await getSkillLevels(apiKey), 'reviving');
                        GM_setValue(SKILL_STORAGE_KEY, reviveSkillLevel);
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
            GM_setValue(API_STORAGE_KEY, apiKey);
            GM_setValue(SKILL_STORAGE_KEY, getSkillLevel(await getSkillLevels(apiKey), 'reviving'));
        }
        return await checkReviveChance(apiKey);
    };

    const addMonitorButton = () => {
        if (!window.location.href.includes('hospitalview.php')) return;

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
            vertical-align: middle;
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

        button.addEventListener('mouseenter', () => { button.style.background = 'rgba(210, 45, 45, 0.8)'; });
        button.addEventListener('mouseleave', () => { button.style.background = redBase; });
        button.addEventListener('click', handleMonitorButtonClick);

        linksWrap.insertBefore(button, linksWrap.firstChild);
    };

    // ==========================================
    // ESTIMATION PIPELINE: Estimate Target Chance
    // ==========================================

    const estimateCurrentChance = (dbScoreTotal, dbTimestamp, userSkill, currentTornTimestamp) => {
        const scoreTotal = Number(dbScoreTotal);
        const updatedTimestamp = Number(dbTimestamp);
        const skillLevel = Number(userSkill);

        if (!Number.isFinite(scoreTotal) || !Number.isFinite(updatedTimestamp) || !Number.isFinite(skillLevel)) {
            throw new TypeError('Invalid database data for revive chance estimation.');
        }

        const elapsedSeconds = currentTornTimestamp - updatedTimestamp;

        if (elapsedSeconds >= SECONDS_PER_DAY) {
            return { chance: 100.00, isFullyDecayed: true };
        }

        let n = Math.ceil(scoreTotal);
        if (n === 0) n = 1;

        const decayAmount = n * (elapsedSeconds / SECONDS_PER_DAY);
        let currentScoreTotal = scoreTotal - decayAmount;
        if (currentScoreTotal < 0) currentScoreTotal = 0;

        const userSkillBase = 90 + (skillLevel / 10);
        const userSkillMultiplier = 8 - (skillLevel / 25);
        let estimatedChance = userSkillBase - (currentScoreTotal * userSkillMultiplier);
        
        if (!Number.isFinite(estimatedChance)) {
            throw new TypeError('Calculated revive chance is not a finite number.');
        }

        if (estimatedChance > 100) estimatedChance = 100;
        if (estimatedChance < 0) estimatedChance = 0;

        debugLog('Local: estimateCurrentChance | Result:', estimatedChance.toFixed(2) + '%');
        return {
            chance: estimatedChance,
            elapsedHours: (elapsedSeconds / 3600)
        };
    };

    const computeScoreTotalFromReviveEvents = (events, currentTornTimestamp) => {
        if (!Array.isArray(events)) throw new TypeError('Expected revive events to be an array.');
        if (!Number.isFinite(currentTornTimestamp) || currentTornTimestamp <= 0) {
            throw new TypeError('Expected currentTornTimestamp to be a positive number.');
        }

        return events.reduce((total, event) => {
            const reviveTimestamp = Number(event?.revive_timestamp ?? event?.timestamp);
            if (!Number.isFinite(reviveTimestamp)) return total;

            const elapsedSeconds = currentTornTimestamp - reviveTimestamp;
            if (elapsedSeconds >= SECONDS_PER_DAY) return total;

            const boundedElapsedSeconds = Math.max(0, elapsedSeconds);
            const contribution = 1 - (boundedElapsedSeconds / SECONDS_PER_DAY);
            return total + Math.max(0, Math.min(1, contribution));
        }, 0);
    };

    const calculateChanceFromEvents = (events, userSkill, currentTornTimestamp) => {
        const scoreTotal = computeScoreTotalFromReviveEvents(events, currentTornTimestamp);
        const chanceBase = 90 + (userSkill / 10);
        const chanceMultiplier = 8 - (userSkill / 25);
        let chance = chanceBase - scoreTotal * chanceMultiplier;

        if (!Number.isFinite(chance)) {
            throw new TypeError('Calculated chance from events is not finite.');
        }

        chance = Math.max(0, Math.min(100, chance));
        return {
            chance,
            scoreTotal,
            eventCount: Array.isArray(events) ? events.length : 0,
        };
    };

    const shouldShowSecondaryLinearDecay = (targetLastActionTimestamp, latestReviveTimestamp, legacyData) => {
        return Number.isFinite(targetLastActionTimestamp) &&
            Number.isFinite(latestReviveTimestamp) &&
            targetLastActionTimestamp > latestReviveTimestamp &&
            !!legacyData;
    };

    const fetchTargetReviveEvents = async (targetId, sinceSeconds = SECONDS_PER_DAY, limit = 500) => {
        const normalizedTargetId = Number.parseInt(targetId, 10);
        if (!Number.isFinite(normalizedTargetId) || normalizedTargetId <= 0) {
            throw new TypeError('Invalid targetId for revive events fetch.');
        }

        const params = new URLSearchParams({
            since_seconds: String(Math.max(1, Number.parseInt(sinceSeconds, 10) || SECONDS_PER_DAY)),
            limit: String(Math.max(1, Number.parseInt(limit, 10) || 500)),
        });

        debugLog('Cloudflare API: fetchTargetReviveEvents | Request Params:', {
            targetId: normalizedTargetId,
            since_seconds: params.get('since_seconds'),
            limit: params.get('limit'),
        });

        const data = await requestJson(`${CLOUDFLARE_API_URL}/revive-events/target/${normalizedTargetId}?${params.toString()}`);
        const events = Array.isArray(data?.data) ? data.data : [];
        debugLog('Cloudflare API: fetchTargetReviveEvents | Events Found:', events.length, '| Target:', normalizedTargetId);
        return events;
    };

    const fetchTargetProfileLastActionTimestamp = async (apiKey, targetId) => {
        const normalizedTargetId = Number.parseInt(targetId, 10);
        if (!Number.isFinite(normalizedTargetId) || normalizedTargetId <= 0) return null;

        try {
            const url = `https://api.torn.com/v2/user/${normalizedTargetId}?selections=profile&key=${encodeURIComponent(apiKey)}`;
            debugLog('Torn API: fetchTargetProfileLastActionTimestamp | Request Target:', normalizedTargetId);
            const data = await requestJson(url);

            const candidates = [
                data?.last_action?.timestamp,
                data?.last_action?.ts,
                data?.profile?.last_action?.timestamp,
                data?.profile?.last_action?.ts,
                data?.last_action,
            ];

            for (const candidate of candidates) {
                const parsedTimestamp = Number(candidate);
                if (Number.isFinite(parsedTimestamp) && parsedTimestamp > 0) {
                    debugLog('Torn API: fetchTargetProfileLastActionTimestamp | Parsed last_action:', parsedTimestamp);
                    return parsedTimestamp;
                }
            }
            debugLog('Torn API: fetchTargetProfileLastActionTimestamp | last_action not found in response.');
        } catch (error) {
            debugLog('Torn API: fetchTargetProfileLastActionTimestamp | Failed:', error?.message || error);
        }

        return null;
    };

    const getMostRecentReviveTimestamp = (events) => {
        if (!Array.isArray(events) || events.length === 0) return null;
        const timestampCandidates = events
            .map((event) => Number(event?.revive_timestamp ?? event?.timestamp))
            .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0);
        if (timestampCandidates.length === 0) return null;
        return Math.max(...timestampCandidates);
    };

    const fetchLegacyEstimateData = (targetId) =>
        new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `${CLOUDFLARE_API_URL}/${targetId}`,
                onload: (response) => {
                    debugLog(`Cloudflare API: GET /${targetId} | Status:`, response.status);
                    debugLog(`Cloudflare API: GET /${targetId} | Response Length:`, response.responseText?.length ?? 0);
                    if (response.status === 404) {
                        resolve(null);
                        return;
                    }

                    try {
                        const data = JSON.parse(response.responseText);
                        const scoreTotal = Number(data.score_total);
                        const lastUpdated = Number(data.last_updated);
                        if (!Number.isFinite(scoreTotal) || !Number.isFinite(lastUpdated)) {
                            reject(new TypeError('Database response missing numeric revive data.'));
                            return;
                        }

                        debugLog(`Cloudflare API: GET /${targetId} | Parsed Payload:`, {
                            score_total: scoreTotal,
                            last_updated: lastUpdated,
                        });

                        resolve({ scoreTotal, lastUpdated });
                    } catch (error) {
                        reject(error);
                    }
                },
                onerror: () => reject(new Error('Failed to connect to legacy estimate endpoint.')),
            });
        });

    const handleEstimateButtonClick = async () => {
        const targetId = getTargetIdFromDOM();
        debugLog('Event: Estimate Button Clicked | Target:', targetId);
        if (!targetId) {
            alert("Could not identify the player ID from this page.");
            return;
        }

        let apiKey = getStoredApiKey();
        if (!apiKey || !(await isValidApiKey(apiKey))) {
            alert("You need a valid API key to synchronize with Torn's server clock. Please use the 'Check Revive Chance' button on the Hospital page to set one up first.");
            return;
        }

        const storedUserSkill = getStoredUserSkill();
        if (storedUserSkill === null) {
            debugLog('Local: handleEstimateButtonClick | Invalid stored user skill:', GM_getValue(SKILL_STORAGE_KEY, null));
            GM_deleteValue(SKILL_STORAGE_KEY);
        }

        const userSkill = promptForUserSkill(
            storedUserSkill,
            storedUserSkill !== null
                ? "Enter your revive skill level (1-100). Leave blank to use your saved skill."
                : "Enter your revive skill level (1-100). Leave blank to assume 100."
        );
        if (userSkill === null) return;

        try {
            const timeRes = await getCurrentTimestamp(apiKey);
            const currentTornTimestamp = Number(timeRes?.timestamp);
            debugLog('Local: handleEstimateButtonClick | Current Torn Timestamp:', currentTornTimestamp);

            if (!Number.isFinite(currentTornTimestamp) || currentTornTimestamp <= 0) {
                alert("Failed to sync with Torn's server clock.");
                return;
            }

            const legacyDataPromise = fetchLegacyEstimateData(targetId).catch((error) => {
                debugLog('Cloudflare API: fetchLegacyEstimateData failed during primary path.', error?.message || error);
                return null;
            });

            try {
                const events = await fetchTargetReviveEvents(targetId, SECONDS_PER_DAY, 500);
                const latestReviveTimestamp = getMostRecentReviveTimestamp(events);
                const targetLastActionTimestamp = await fetchTargetProfileLastActionTimestamp(apiKey, targetId);
                const legacyDataForSecondary = await legacyDataPromise;

                debugLog('Local: estimate revives_events context | latestReviveTimestamp / targetLastActionTimestamp:', {
                    latestReviveTimestamp,
                    targetLastActionTimestamp,
                    hasLegacyDataForSecondary: !!legacyDataForSecondary,
                });

                if (events.length === 0) {
                    let secondarySection = '';
                    if (legacyDataForSecondary) {
                        const secondaryEstimate = estimateCurrentChance(
                            legacyDataForSecondary.scoreTotal,
                            legacyDataForSecondary.lastUpdated,
                            userSkill,
                            currentTornTimestamp
                        );

                        debugLog('Local: estimate revives_events | 0 events; computed secondary legacy estimate:', secondaryEstimate.chance.toFixed(2));
                        secondarySection = `\n\nLast Known Chance Predicts: ${secondaryEstimate.chance.toFixed(2)}%`;
                    }

                    debugLog('Local: estimate revives_events | No events in 24h. Returning 100% primary estimate.');

                    alert(
                        `Estimation Results:\n\n` +
                        `Estimated Current Chance: 100.00%\n\n` +
                        `No revive events were recorded for this target in the last 24 hours,\n` +
                        `rely instead on last known chance data.\n` +
                        secondarySection
                    );
                    return;
                }

                const estimate = calculateChanceFromEvents(events, userSkill, currentTornTimestamp);
                const secondaryEstimate = legacyDataForSecondary
                    ? estimateCurrentChance(
                        legacyDataForSecondary.scoreTotal,
                        legacyDataForSecondary.lastUpdated,
                        userSkill,
                        currentTornTimestamp
                    )
                    : null;
                const secondaryIsLower = !!secondaryEstimate && secondaryEstimate.chance < estimate.chance;
                const showSecondaryLinearDecay = shouldShowSecondaryLinearDecay(
                    targetLastActionTimestamp,
                    latestReviveTimestamp,
                    legacyDataForSecondary
                );
                const shouldShowSecondary = !!secondaryEstimate && (showSecondaryLinearDecay || secondaryIsLower);

                debugLog('Local: estimate revives_events | Primary Estimate:', {
                    chance: estimate.chance,
                    scoreTotal: estimate.scoreTotal,
                    eventCount: estimate.eventCount,
                    shouldShowSecondaryLinearDecay: shouldShowSecondary,
                    secondaryIsLower,
                });

                const notes = [];
                let secondaryEstimateSection = '';
                if (shouldShowSecondary) {
                    debugLog('Local: estimate revives_events | Secondary linear decay estimate appended:', secondaryEstimate.chance.toFixed(2));
                    secondaryEstimateSection =
                        `\n\nSecondary (linear decay from last-known chance): ${secondaryEstimate.chance.toFixed(2)}%` +
                        (secondaryIsLower
                            ? `\nCondition: secondary estimate is lower than the primary model.`
                            : `\nCondition: target last action is newer than most recent revive event.`);
                    if (secondaryIsLower) {
                        notes.push('Legacy estimate is lower than the revive-events estimate.');
                    }
                } else {
                    if (!legacyDataForSecondary) {
                        notes.push('Legacy estimate is unavailable for this target.');
                    } else if (targetLastActionTimestamp <= latestReviveTimestamp) {
                        notes.push('Legacy estimate is available but not newer than the latest revive event.');
                    } else {
                        notes.push('Legacy estimate is available but not lower than the revive-events estimate.');
                    }
                    debugLog('Local: estimate revives_events | Secondary linear decay estimate not shown.', {
                        targetLastActionTimestamp,
                        latestReviveTimestamp,
                        hasLegacyDataForSecondary: !!legacyDataForSecondary,
                        secondaryIsLower,
                    });
                }

                alert(
                    `Estimation Results:\n\n` +
                    `Estimated Current Chance: ${estimate.chance.toFixed(2)}%\n\n` +
                    `Events used (last 24h): ${estimate.eventCount}\n` +
                    `Computed Score Total: ${estimate.scoreTotal.toFixed(4)}\n` +
                    `Model: revive_events (24h)` +
                    (notes.length ? `\n${notes.join('\n')}` : '') +
                    secondaryEstimateSection
                );
                return;
            } catch (eventsError) {
                debugLog('Cloudflare API: revive_events estimate failed, falling back to legacy aggregate.', eventsError?.message || eventsError);
            }

            const legacyData = await fetchLegacyEstimateData(targetId);
            if (!legacyData) {
                debugLog('Local: estimate fallback | No legacy data found for target:', targetId);
                alert("No revive data found for this player in the database.");
                return;
            }

            const estimate = estimateCurrentChance(
                legacyData.scoreTotal,
                legacyData.lastUpdated,
                userSkill,
                currentTornTimestamp
            );

            debugLog('Local: estimate fallback | Legacy aggregate estimate:', {
                chance: estimate.chance,
                elapsedHours: estimate.elapsedHours,
                isFullyDecayed: !!estimate.isFullyDecayed,
            });

            if (estimate.isFullyDecayed) {
                alert(`Target has not been revived in over 24 hours.\n\nEstimated Chance: 100%\n\nModel fallback: legacy aggregate`);
            } else {
                alert(
                    `Estimation Results:\n\n` +
                    `Estimated Current Chance: ${estimate.chance.toFixed(2)}%\n\n` +
                    `Data recorded ${estimate.elapsedHours.toFixed(1)} hours ago.\n` +
                    `Model fallback: legacy aggregate\n` +
                    `*Note: This fallback assumes the slowest possible decay rate. Actual chance may be slightly higher.*`
                );
            }
        } catch (error) {
             console.error("Failed to estimate:", error);
        }
    };

    const addEstimateButton = () => {
        if (!window.location.href.includes('profiles.php')) return;

        const linksWrap = document.querySelector('.content-title-links');
        if (!linksWrap) return;

        let button = linksWrap.querySelector('#dragon-heart-estimate-btn');
        if (button) return;

        button = document.createElement('button');
        button.id = 'dragon-heart-estimate-btn';
        button.type = 'button';
        button.setAttribute('aria-label', 'Estimate revive chance');

        const setButtonLabel = () => {
            const mobile = window.matchMedia('(max-width: 768px)').matches;
            button.textContent = mobile ? '🐲' : '🐲Estimate Revive Chance🐲';
        };

        setButtonLabel();
        window.addEventListener('resize', setButtonLabel);

        const redBase = 'rgba(231, 71, 71, 0.66)';
        button.style.cssText = `
            display: inline-flex;
            align-items: center;
            vertical-align: middle;
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

        button.addEventListener('mouseenter', () => { button.style.background = 'rgba(210, 45, 45, 0.8)'; });
        button.addEventListener('mouseleave', () => { button.style.background = redBase; });
        button.addEventListener('click', handleEstimateButtonClick);

        linksWrap.insertBefore(button, linksWrap.firstChild);
    };

    // ==========================================
    // COLLECTION PIPELINE: Worker API push logic
    // ==========================================

    const pushReviveDataToWorker = (targetId, scoreTotal, tornTimestamp) => {
        const endpoint = `${CLOUDFLARE_API_URL}/${targetId}`;
        debugLog('Cloudflare API: Pushing revive data | Target:', targetId);

        GM_xmlhttpRequest({
            method: "POST",
            url: endpoint,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ score_total: scoreTotal, torn_timestamp: tornTimestamp }),
            onload: (response) => {
                debugLog(`Cloudflare API: POST /${targetId} | Status:`, response.status);
                debugLog(`Cloudflare API: POST /${targetId} | Response Length:`, response.responseText?.length ?? 0);

                const responseBody = response.responseText ?? '';
                if (responseBody.trim().startsWith('{')) {
                    const payload = JSON.parse(responseBody);
                    debugLog(`Cloudflare API: POST /${targetId} | Parsed Response:`, payload);
                } else {
                    debugLog(`Cloudflare API: POST /${targetId} | Non-JSON Response:`, response.responseText);
                }
            },
            onerror: () => {
                debugLog(`Cloudflare API: POST /${targetId} | Status: FAILED`);
            }
        });
    };

    const extractReviveId = (revive, fallbackId = null) => {
        const candidate = revive?.revive_id ?? revive?.id ?? fallbackId;
        const parsedCandidate = Number.parseInt(candidate, 10);
        if (Number.isFinite(parsedCandidate) && parsedCandidate > 0) return parsedCandidate;
        return null;
    };

    const extractReviveTimestamp = (revive) => {
        const parsedTimestamp = Number.parseInt(revive?.timestamp, 10);
        if (Number.isFinite(parsedTimestamp) && parsedTimestamp > 0) return parsedTimestamp;
        return null;
    };

    const normalizeRevivesForUpload = (revives, sourceUserId = null) => {
        if (!Array.isArray(revives)) return [];

        return revives
            .map((revive, index) => {
                const fallbackId = Number.isFinite(index) ? index + 1 : null;
                const reviveId = extractReviveId(revive, fallbackId);
                const reviveTimestamp = extractReviveTimestamp(revive);
                if (!reviveId || !reviveTimestamp) return null;

                return {
                    ...revive,
                    revive_id: reviveId,
                    timestamp: reviveTimestamp,
                    source_user_id: sourceUserId,
                };
            })
            .filter(Boolean);
    };

    const pushRevivesFullToWorker = async (apiKey, revives, pulledAtTimestamp) => {
        const normalizedRevives = normalizeRevivesForUpload(revives);
        if (normalizedRevives.length === 0) {
            debugLog('Cloudflare API: revivesFull push skipped (no valid revives).');
            return;
        }

        const latestReviveTimestamp = normalizedRevives.reduce(
            (maxTimestamp, revive) => Math.max(maxTimestamp, Number(revive.timestamp) || 0),
            0
        );

        const lastPushedTimestamp = getStoredLastRevivesFullPushTimestamp();
        const newRevives = normalizedRevives.filter((revive) => Number(revive.timestamp) > lastPushedTimestamp);

        if (newRevives.length === 0) {
            debugLog('Cloudflare API: revivesFull push skipped (no new revives).', {
                lastPushedTimestamp,
                latestReviveTimestamp,
            });
            return;
        }

        try {
            const sourceProfile = await requestJson(`https://api.torn.com/v2/user/?selections=profile&key=${encodeURIComponent(apiKey)}`);
            const sourceUserId = Number.parseInt(sourceProfile?.player_id ?? sourceProfile?.profile?.player_id, 10);

            const payload = {
                pulled_at: Number(pulledAtTimestamp),
                source_user_id: Number.isFinite(sourceUserId) ? sourceUserId : null,
                revives: newRevives.map((revive) => ({
                    ...revive,
                    source_user_id: Number.isFinite(sourceUserId) ? sourceUserId : null,
                })),
            };

            await new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: `${CLOUDFLARE_API_URL}/revivesfull`,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify(payload),
                    onload: (response) => {
                        debugLog('Cloudflare API: POST /revivesfull | Status:', response.status);
                        if (response.status >= 200 && response.status < 300) {
                            setStoredLastRevivesFullPushTimestamp(latestReviveTimestamp);
                            debugLog('Cloudflare API: revivesFull push complete.', {
                                sentCount: payload.revives.length,
                                latestReviveTimestamp,
                            });
                        } else {
                            debugLog('Cloudflare API: revivesFull push failed with non-2xx response.', response.responseText);
                        }
                        resolve();
                    },
                    onerror: () => {
                        debugLog('Cloudflare API: POST /revivesfull | Status: FAILED');
                        resolve();
                    },
                    ontimeout: () => {
                        debugLog('Cloudflare API: POST /revivesfull | Status: TIMEOUT');
                        resolve();
                    },
                });
            });
        } catch (error) {
            debugLog('Cloudflare API: revivesFull push aborted due to preparation error.', error?.message || error);
        }
    };

    const runPassiveRevivesCollection = async (reason = 'interval', currentTimestampSeconds = null) => {
        if (window.__dragonHeartPassiveCollectionInFlight) {
            debugLog('Passive Collection: skipped because previous run is still in flight.', { reason });
            return;
        }

        window.__dragonHeartPassiveCollectionInFlight = true;
        try {
            const apiKey = getStoredApiKey();
            if (!apiKey || !(await isValidApiKey(apiKey))) {
                debugLog('Passive Collection: skipped due to missing or invalid API key.', { reason });
                return;
            }

            let resolvedCurrentTimestampSeconds = Number(currentTimestampSeconds);
            if (!Number.isFinite(resolvedCurrentTimestampSeconds) || resolvedCurrentTimestampSeconds <= 0) {
                const currentTimestampResponse = await getCurrentTimestamp(apiKey);
                resolvedCurrentTimestampSeconds = Number(currentTimestampResponse?.timestamp);
            }

            if (!Number.isFinite(resolvedCurrentTimestampSeconds) || resolvedCurrentTimestampSeconds <= 0) {
                debugLog('Passive Collection: skipped due to invalid server timestamp.', { reason });
                return;
            }

            const lastPushed = getStoredLastRevivesFullPushTimestamp();
            const fromUnixSeconds = lastPushed > 0
                ? Math.max(0, lastPushed - PASSIVE_COLLECTION_OVERLAP_SECONDS)
                : getFromTimestampForLastHours(resolvedCurrentTimestampSeconds, 24);

            const revives = await fetchRevives(apiKey, fromUnixSeconds);
            await pushRevivesFullToWorker(apiKey, revives, resolvedCurrentTimestampSeconds);
            setStoredLastPassiveRunTimestamp(resolvedCurrentTimestampSeconds);

            debugLog('Passive Collection: completed.', {
                reason,
                fromUnixSeconds,
                revivesFetched: Array.isArray(revives) ? revives.length : 0,
            });
        } catch (error) {
            debugLog('Passive Collection: failed.', error?.message || error);
        } finally {
            window.__dragonHeartPassiveCollectionInFlight = false;
        }
    };

    const stopPassiveRevivesCollection = () => {
        if (window.__dragonHeartPassiveCollectionIntervalId) {
            window.clearInterval(window.__dragonHeartPassiveCollectionIntervalId);
            window.__dragonHeartPassiveCollectionIntervalId = null;
        }
    };

    const restartPassiveRevivesCollection = (reason = 'manual-restart') => {
        stopPassiveRevivesCollection();
        initializePassiveRevivesCollection(reason);
    };

    const registerPassiveCollectionMenuCommands = () => {
        GM_registerMenuCommand('Refresh revives on server now', () => {
            void runPassiveRevivesCollection('manual-menu-refresh');
        });

        for (const minutes of PASSIVE_INTERVAL_OPTIONS_MINUTES) {
            GM_registerMenuCommand(`Set passive refresh interval: ${minutes} minutes`, () => {
                const changed = setStoredPassiveIntervalMinutes(minutes);
                if (!changed) {
                    alert('Failed to update passive refresh interval setting.');
                    return;
                }

                restartPassiveRevivesCollection('menu-interval-change');
                alert(`Passive refresh interval updated to every ${minutes} minutes.`);
            });
        }
    };

    registerPassiveCollectionMenuCommands();

    const initializePassiveRevivesCollection = (reason = 'startup') => {
        if (window.__dragonHeartPassiveCollectionIntervalId) return;

        const intervalMinutes = getStoredPassiveIntervalMinutes();
        const intervalMs = intervalMinutes * 60 * 1000;

        debugLog('Passive Collection: scheduler starting.', {
            reason,
            intervalMinutes,
            lastRunTimestamp: getStoredLastPassiveRunTimestamp(),
        });

        void maybeRunPassiveRevivesCollection('startup');

        const intervalId = window.setInterval(() => {
            void maybeRunPassiveRevivesCollection('interval');
        }, intervalMs);

        window.__dragonHeartPassiveCollectionIntervalId = intervalId;

        window.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            void maybeRunPassiveRevivesCollection('visibility-resume');
        });
    };

    const maybeRunPassiveRevivesCollection = async (reason = 'interval') => {
        const apiKey = getStoredApiKey();
        if (!apiKey || !(await isValidApiKey(apiKey))) {
            debugLog('Passive Collection: skipped due to missing or invalid API key.', { reason });
            return;
        }

        const currentTimestampResponse = await getCurrentTimestamp(apiKey);
        const currentTimestampSeconds = Number(currentTimestampResponse?.timestamp);
        if (!Number.isFinite(currentTimestampSeconds) || currentTimestampSeconds <= 0) {
            debugLog('Passive Collection: skipped due to invalid server timestamp.', { reason });
            return;
        }

        const intervalMinutes = getStoredPassiveIntervalMinutes();
        const lastRunTimestamp = getStoredLastPassiveRunTimestamp();
        if (!shouldRunPassiveCollectionNow(lastRunTimestamp, intervalMinutes, currentTimestampSeconds)) {
            debugLog('Passive Collection: skipped because interval has not elapsed yet.', {
                reason,
                lastRunTimestamp,
                currentTimestampSeconds,
                intervalMinutes,
            });
            return;
        }

        await runPassiveRevivesCollection(reason, currentTimestampSeconds);
    };

    const getTargetIdFromDOM = () => {
        const params = new URLSearchParams(window.location.search);
        if (params.has('XID')) return params.get('XID');

        const reviveBtn = document.querySelector('a.profile-button-revive[href*="ID="]');
        if (reviveBtn) {
            const match = reviveBtn.href.match(/ID=(\d+)/);
            if (match) return match[1];
        }

        return null;
    };

    const watchForReviveDialog = () => {
        const observer = new MutationObserver(async (mutations) => {
            for (const mutation of mutations) {
                if (mutation.addedNodes.length) {
                    const dialogTextElement = document.querySelector('.profile-buttons-dialog .text');
                    
                    if (dialogTextElement) {
                        const match = new RegExp(/has a ([\d.]+)% chance/).exec(dialogTextElement.textContent);
                        
                        if (match) {
                            const chance = Number.parseFloat(match[1]);
                            const targetId = getTargetIdFromDOM();
                            
                            if (targetId && !Number.isNaN(chance)) {
                                const currentDataHash = `${targetId}-${chance}`;
                                
                                if (lastSubmittedData !== currentDataHash) {
                                    lastSubmittedData = currentDataHash;
                                    debugLog('Event: Revive Dialog Detected | Intercepted Chance:', chance + '%');

                                    const apiKey = getStoredApiKey();
                                    if (!apiKey) return;

                                    const mySkill = getStoredUserSkill();
                                    if (mySkill === null) {
                                        debugLog('Local: Collection Math | Skipping collection because no valid stored user skill is available.');
                                        return;
                                    }

                                    debugLog('Local: Collection Math | User Skill:', mySkill);
                                    
                                    const skillBase = 90 + (mySkill / 10);
                                    const skillMultiplier = 8 - (mySkill / 25);
                                    debugLog('Local: Collection Math | Skill Base / Multiplier:', skillBase, skillMultiplier);
                                    let exactScoreTotal = (skillBase - chance) / skillMultiplier;
                                    if (exactScoreTotal < 0) exactScoreTotal = 0;
                                    
                                    debugLog('Local: Collection Math | Universal Score:', exactScoreTotal.toFixed(4));

                                    try {
                                        const timeRes = await getCurrentTimestamp(apiKey);
                                        const tornTimestamp = Number(timeRes?.timestamp);
                                        
                                        if (tornTimestamp > 0) {
                                            pushReviveDataToWorker(targetId, exactScoreTotal, tornTimestamp);
                                        }
                                    } catch (err) {
                                        // Intentionally ignored: a timestamp fetch failure should not block local collection.
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    };

    // Initialize 
    addMonitorButton();
    addEstimateButton();
    watchForReviveDialog();
    initializePassiveRevivesCollection();
})();