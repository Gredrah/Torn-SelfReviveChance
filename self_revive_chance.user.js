// ==UserScript==
// @name         Dragon's Heart Monitor
// @author       Gredrah
// @namespace    https://www.github.com/gredrah/
//
// @version      1.1.0
// @description  Provides Torn players with a quick way to check their revive chance against different skill levels of reviver. Accessed via the Hospital page. Also collects and stores the last known revive chance for each player in a Cloudflare Worker database, which can be used to estimate the current revive chance of a target player.
// @match        https://www.torn.com/hospitalview.php*
// @match        https://www.torn.com/profiles.php*
// @license      UNLICENSE
//
// @grant GM_xmlhttpRequest
// @grant GM_getValue
// @grant GM_setValue
// @connect api.gredra.com
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
    const data = await requestJson(`https://api.torn.com/user/?selections=skills&key=${encodeURIComponent(apiKey)}`);
    const skills = data.skills;
    if (!skills) throw new Error("Failed to retrieve skills from API response.");
    return skills;
}

function getSkillLevel(skills, skillName) {
    if (!skills || !Array.isArray(skills)) throw new TypeError("Invalid skills object. Expected an array.");
    const skill = skills.find(s => s.slug === skillName.toLowerCase());
    if (!skill) throw new Error(`Skill "${skillName}" not found in skills object.`);
    return skill.level;
}

// util/api.js
async function requestJson(url) {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'GET',
            url,
            responseType: 'text',
            onload: (response) => {
                try { resolve(JSON.parse(response.responseText)); } 
                catch (error) { reject(error); }
            },
            onerror: () => reject(new Error('Request failed')),
            ontimeout: () => reject(new Error('Request timed out')),
        });
    });
}

async function isValidApiKey(apiKey) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) return false;
    try {
        const url = `https://api.torn.com/user/?selections=basic&key=${encodeURIComponent(apiKey.trim())}`;
        const data = await requestJson(url);
        return data?.error === undefined || data?.error === 0 || data?.error === '0';
    } catch {
        return false;
    }
}

async function getCurrentTimestamp(apiKey) {
    debugLog('Requesting current timestamp (public v2 endpoint).');
    const publicResponse = await requestJson('https://api.torn.com/v2/torn/timestamp');
    if (Number.isFinite(Number(publicResponse?.timestamp))) return publicResponse;

    const publicError = publicResponse?.error;
    const isKeyRelatedPublicError = typeof publicError?.error === 'string' && /incorrect key|key/i.test(publicError.error);

    if (!apiKey || !isKeyRelatedPublicError) return publicResponse;

    return await requestJson(`https://api.torn.com/v2/torn/timestamp?key=${encodeURIComponent(apiKey)}`);
}

// util/revives.js
async function fetchRevives(apiKey, fromUnixSeconds = 0) {
    const params = new URLSearchParams({ key: apiKey, filters: 'incoming' });
    if (fromUnixSeconds > 0) params.set('from', String(fromUnixSeconds));

    const url = `https://api.torn.com/v2/user/revivesFull?${params.toString()}`;
    const data = await requestJson(url);

    if (data?.error) throw new Error(`Failed to retrieve revives: ${data.error.error || 'Unknown API error'}`);

    const revivesPayload = data?.revives ?? data?.revivesFull ?? data?.revivesfull;
    if (Array.isArray(revivesPayload)) return revivesPayload;
    if (revivesPayload && typeof revivesPayload === 'object') return Object.values(revivesPayload);
    return [];
}

(function() {
    'use strict';

    const API_STORAGE_KEY = "monitor_api_key";
    const SKILL_STORAGE_KEY = "monitor_revive_skill";
    const API_KEY_URL = "https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Dragon's Heart Monitor&user=basic,revivesfull,skills";
    const CLOUDFLARE_API_URL = "https://revives.api.gredra.com";
    
    let lastSubmittedData = ""; 

    const getStoredApiKey = () => GM_getValue(API_STORAGE_KEY, null);
    const generateApiKey = () => window.open(API_KEY_URL, "_blank", "noopener,noreferrer");

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

            const annotatedRevives = annotateRevivesWithAge(revives, currentTimestampSeconds);
            
            const scoreTotal = annotatedRevives.reduce((total, revive) => {
                return total + (1 - (revive.elapsedSeconds / SECONDS_PER_DAY));
            }, 0);

            const reviveChance = 90 + (reviveSkill / 10) - scoreTotal * (8 - (reviveSkill / 25));

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
                        GM_setValue(API_STORAGE_KEY, apiKey);
                        GM_setValue(SKILL_STORAGE_KEY, getSkillLevel(await getSkillLevels(apiKey), 'reviving').level);
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
            GM_setValue(SKILL_STORAGE_KEY, getSkillLevel(await getSkillLevels(apiKey), 'reviving').level);
        }
        return await checkReviveChance(apiKey);
    };

    const addMonitorButton = () => {
        // Gate check: Only render on Hospital View
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

        button.addEventListener('mouseenter', () => button.style.background = 'rgba(210, 45, 45, 0.8)');
        button.addEventListener('mouseleave', () => button.style.background = redBase);
        button.addEventListener('click', handleMonitorButtonClick);

        linksWrap.insertBefore(button, linksWrap.firstChild);
    };

    // ==========================================
    // ESTIMATION PIPELINE: Estimate Target Chance
    // ==========================================

    const estimateCurrentChance = (dbScoreTotal, dbTimestamp, userSkill) => {
        const now = Math.floor(Date.now() / 1000);
        const elapsedSeconds = now - dbTimestamp;

        if (elapsedSeconds >= SECONDS_PER_DAY) {
            return { chance: 100.00, isFullyDecayed: true };
        }

        let n = Math.ceil(dbScoreTotal);
        if (n === 0) n = 1;

        const decayAmount = n * (elapsedSeconds / SECONDS_PER_DAY);
        let currentScoreTotal = dbScoreTotal - decayAmount;
        if (currentScoreTotal < 0) currentScoreTotal = 0;

        const userSkillBase = 90 + (userSkill / 10);
        const userSkillMultiplier = 8 - (userSkill / 25);
        let estimatedChance = userSkillBase - (currentScoreTotal * userSkillMultiplier);
        
        if (estimatedChance > 100) estimatedChance = 100;

        return {
            chance: estimatedChance,
            elapsedHours: (elapsedSeconds / 3600)
        };
    };

    const handleEstimateButtonClick = () => {
        const targetId = getTargetIdFromDOM();
        if (!targetId) {
            alert("Could not identify the player ID from this page.");
            return;
        }

        let userSkill = GM_getValue(SKILL_STORAGE_KEY, null);
        if (userSkill === null) {
            let reviveSkillInput = prompt("Enter your revive skill level (1-100). Leave blank to assume 100.");
            if (reviveSkillInput === null) return;
            
            userSkill = 100.00;
            if (reviveSkillInput.trim() !== "") {
                userSkill = Number.parseFloat(reviveSkillInput);
                if (Number.isNaN(userSkill) || userSkill < 0 || userSkill > 100) {
                    alert("Invalid skill level.");
                    return;
                }
            }
        }

        GM_xmlhttpRequest({
            method: "GET",
            url: `${CLOUDFLARE_API_URL}/${targetId}`,
            onload: (response) => {
                if (response.status === 404) {
                    alert("No revive data found for this player in the database.");
                    return;
                }

                try {
                    const data = JSON.parse(response.responseText);
                    const estimate = estimateCurrentChance(data.score_total, data.last_updated, userSkill);

                    if (estimate.isFullyDecayed) {
                        alert(`Target has not been revived in over 24 hours.\n\nEstimated Chance: 100%`);
                    } else {
                        alert(
                            `Estimation Results:\n\n` +
                            `Estimated Current Chance: ${estimate.chance.toFixed(2)}%\n\n` +
                            `Data recorded ${estimate.elapsedHours.toFixed(1)} hours ago.\n` +
                            `*Note: This assumes the slowest possible decay rate. Actual chance may be slightly higher.*`
                        );
                    }
                } catch (e) {
                    alert("Failed to parse database response.");
                }
            },
            onerror: () => alert("Failed to connect to the database.")
        });
    };

    const addEstimateButton = () => {
        // Gate check: Only render on Profiles View
        if (!window.location.href.includes('profiles.php')) return;

        const linksWrap = document.querySelector('.content-title-links');
        if (!linksWrap) return;

        let button = linksWrap.querySelector('#dragon-heart-estimate-btn');
        if (button) return;

        button = document.createElement('button');
        button.id = 'dragon-heart-estimate-btn';
        button.type = 'button';
        button.setAttribute('aria-label', 'Estimate revive chance');

        // Added responsive sizing logic similar to Monitor button
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

        button.addEventListener('mouseenter', () => button.style.background = 'rgba(210, 45, 45, 0.8)');
        button.addEventListener('mouseleave', () => button.style.background = redBase);
        button.addEventListener('click', handleEstimateButtonClick);

        linksWrap.insertBefore(button, linksWrap.firstChild);
    };

    // ==========================================
    // COLLECTION PIPELINE: Worker API push logic
    // ==========================================

    const pushReviveDataToWorker = (targetId, scoreTotal) => {
        const endpoint = `${CLOUDFLARE_API_URL}/${targetId}`;
        debugLog(`Pushing revive data to worker: ID ${targetId} at score ${scoreTotal}`);

        GM_xmlhttpRequest({
            method: "POST",
            url: endpoint,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ score_total: scoreTotal }),
            onload: (response) => {
                debugLog(`Worker response for ${targetId}:`, response.responseText);
            },
            onerror: (error) => {
                console.error(`[Dragon's Heart Monitor] Failed to push data for ${targetId}:`, error);
            }
        });
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
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.addedNodes.length) {
                    const dialogTextElement = document.querySelector('.profile-buttons-dialog .text');
                    
                    if (dialogTextElement) {
                        const match = dialogTextElement.textContent.match(/has a ([\d.]+)% chance/);
                        
                        if (match) {
                            const chance = parseFloat(match[1]);
                            const targetId = getTargetIdFromDOM();
                            
                            if (targetId && !isNaN(chance)) {
                                const currentDataHash = `${targetId}-${chance}`;
                                
                                if (lastSubmittedData !== currentDataHash) {
                                    lastSubmittedData = currentDataHash;

                                    const mySkill = GM_getValue(SKILL_STORAGE_KEY, 100);
                                    
                                    const skillBase = 90 + (mySkill / 10);
                                    const skillMultiplier = 8 - (mySkill / 25);
                                    let exactScoreTotal = (skillBase - chance) / skillMultiplier;
                                    if (exactScoreTotal < 0) exactScoreTotal = 0;

                                    pushReviveDataToWorker(targetId, exactScoreTotal);
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
})();