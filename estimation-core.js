const SECONDS_PER_DAY = 86400;

function estimateCurrentChance(dbScoreTotal, dbTimestamp, userSkill, currentTornTimestamp) {
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

    return {
        chance: estimatedChance,
        elapsedHours: (elapsedSeconds / 3600)
    };
}

function computeScoreTotalFromReviveEvents(events, currentTornTimestamp) {
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
}

function calculateChanceFromEvents(events, userSkill, currentTornTimestamp) {
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
}

function getMostRecentReviveTimestamp(events) {
    if (!Array.isArray(events) || events.length === 0) return null;
    const timestampCandidates = events
        .map((event) => Number(event?.revive_timestamp ?? event?.timestamp))
        .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0);
    if (timestampCandidates.length === 0) return null;
    return Math.max(...timestampCandidates);
}

function shouldShowSecondaryLinearDecay(targetLastActionTimestamp, latestReviveTimestamp, legacyData) {
    return Number.isFinite(targetLastActionTimestamp) &&
        Number.isFinite(latestReviveTimestamp) &&
        targetLastActionTimestamp > latestReviveTimestamp &&
        !!legacyData;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SECONDS_PER_DAY,
        estimateCurrentChance,
        computeScoreTotalFromReviveEvents,
        calculateChanceFromEvents,
        getMostRecentReviveTimestamp,
        shouldShowSecondaryLinearDecay,
    };
}
