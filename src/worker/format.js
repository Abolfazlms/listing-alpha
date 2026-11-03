/** Presentation helpers shared by the bot and the site generator. */

export { KIND } from '../pipeline/normalize.js';

const TIER_LABELS = {
  A: 'HIGH SIGNAL',
  B: 'NOTABLE',
  C: 'ROUTINE',
  D: 'NOISE',
};

/** @param {string} tier */
export function tierLabel(tier) {
  return TIER_LABELS[tier] || 'ROUTINE';
}

/** 92 -> "92", 7 -> "07" (stable width keeps tables aligned). */
export function padScore(score) {
  return String(Math.max(0, Math.min(99, Number(score) || 0))).padStart(2, '0');
}

/** Human readable duration from seconds. */
export function humanizeSeconds(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
