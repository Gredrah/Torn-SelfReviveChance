const test = require('node:test');
const assert = require('node:assert/strict');

const {
    SECONDS_PER_DAY,
    estimateCurrentChance,
    computeScoreTotalFromReviveEvents,
    calculateChanceFromEvents,
    getMostRecentReviveTimestamp,
    shouldShowSecondaryLinearDecay,
} = require('./estimation-core');

const fixedNow = 1_700_000_000;
const oneHour = 3600;

function makeEvent(secondsAgo, extra = {}) {
    return {
        revive_timestamp: fixedNow - secondsAgo,
        ...extra,
    };
}

test('computeScoreTotalFromReviveEvents weights events by age', () => {
    const events = [
        makeEvent(0),
        makeEvent(oneHour),
        makeEvent(6 * oneHour),
        makeEvent(23 * oneHour),
    ];

    const scoreTotal = computeScoreTotalFromReviveEvents(events, fixedNow);

    assert.ok(scoreTotal > 2.3 && scoreTotal < 3.1, `unexpected score total: ${scoreTotal}`);
});

test('computeScoreTotalFromReviveEvents rejects invalid input', () => {
    assert.throws(() => computeScoreTotalFromReviveEvents(null, fixedNow), /Expected revive events to be an array/);
    assert.throws(() => computeScoreTotalFromReviveEvents([], 0), /Expected currentTornTimestamp to be a positive number/);
});

test('calculateChanceFromEvents returns a clamped chance and event count', () => {
    const events = [makeEvent(0), makeEvent(2 * oneHour), makeEvent(5 * oneHour)];
    const result = calculateChanceFromEvents(events, 100, fixedNow);

    assert.equal(result.eventCount, 3);
    assert.ok(result.chance >= 0 && result.chance <= 100);
    assert.ok(result.scoreTotal > 0);
});

test('getMostRecentReviveTimestamp returns the newest timestamp', () => {
    const events = [makeEvent(4 * oneHour), makeEvent(2 * oneHour), makeEvent(9 * oneHour)];

    assert.equal(getMostRecentReviveTimestamp(events), fixedNow - 2 * oneHour);
    assert.equal(getMostRecentReviveTimestamp([]), null);
});

test('estimateCurrentChance fully decays after a day', () => {
    const result = estimateCurrentChance(12, fixedNow - SECONDS_PER_DAY - 10, 70, fixedNow);

    assert.equal(result.chance, 100);
    assert.equal(result.isFullyDecayed, true);
});

test('estimateCurrentChance stays within expected bounds', () => {
    const result = estimateCurrentChance(2.5, fixedNow - 3 * oneHour, 80, fixedNow);

    assert.ok(result.chance >= 0 && result.chance <= 100);
    assert.ok(result.elapsedHours > 0);
});

test('estimateCurrentChance rejects invalid input', () => {
    assert.throws(() => estimateCurrentChance('bad', fixedNow, 80, fixedNow), /Invalid database data/);
});

test('newest estimate stays within 2.5 percent of the fixture oracle', () => {
    const oracleEvents = [
        makeEvent(15 * oneHour),
        makeEvent(18 * oneHour),
        makeEvent(21 * oneHour),
        makeEvent(23 * oneHour),
    ];
    const userSkill = 100;
    const currentTornTimestamp = fixedNow;
    const actual = calculateChanceFromEvents(oracleEvents, userSkill, currentTornTimestamp).chance;
    const expected = 97.2;
    const relativeError = Math.abs(actual - expected) / expected;

    assert.ok(relativeError <= 0.025, `relative error ${relativeError} exceeded 2.5%`);
});

test('shouldShowSecondaryLinearDecay only returns true when the target was active after the newest revive event', () => {
    const latestReviveTimestamp = fixedNow - 3 * oneHour;
    const newerLastAction = fixedNow - oneHour;
    const olderLastAction = fixedNow - 6 * oneHour;

    assert.equal(shouldShowSecondaryLinearDecay(newerLastAction, latestReviveTimestamp, { scoreTotal: 12 }), true);
    assert.equal(shouldShowSecondaryLinearDecay(olderLastAction, latestReviveTimestamp, { scoreTotal: 12 }), false);
    assert.equal(shouldShowSecondaryLinearDecay(newerLastAction, latestReviveTimestamp, null), false);
});
