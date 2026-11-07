// The two risk methods from the course, as working code.
//
// Weighted Security Exposure Score (WSES) rates a COMPONENT:
//   WSES = (Accessibility x 2) + (Data Sensitivity x 3) + (Past Incidents x 2) + (Complexity x 1)
//   with each parameter scored Low = 1, Medium = 3, High = 5.
// FMEA rates one way a component can FAIL:
//   RPN = Severity x Occurrence x Detection, each rated 1 to 10.
// Both accept other weights or scales, as the course exercises use (for example 4/5/3/2 and 1/5/8).

const WSES_PARAMETERS = Object.freeze(["accessibility", "dataSensitivity", "pastIncidents", "complexity"]);
const WSES_WEIGHTS = Object.freeze({ accessibility: 2, dataSensitivity: 3, pastIncidents: 2, complexity: 1 });
const WSES_LEVELS = Object.freeze({ Low: 1, Medium: 3, High: 5 });

class RiskInputError extends Error {}

function levelScore(value, levels, name) {
  if (typeof value === "string") {
    if (!Object.hasOwn(levels, value)) throw new RiskInputError(`${name} must be one of ${Object.keys(levels).join(", ")}.`);
    return levels[value];
  }
  if (!Number.isFinite(value) || value < 0) throw new RiskInputError(`${name} must be a level name or a positive number.`);
  return value;
}

// ratings: { accessibility, dataSensitivity, pastIncidents, complexity }, each a level name or a score
function wses(ratings, { weights = WSES_WEIGHTS, levels = WSES_LEVELS } = {}) {
  return WSES_PARAMETERS.reduce((total, name) => {
    if (!Object.hasOwn(weights, name)) throw new RiskInputError(`No weight for ${name}.`);
    return total + levelScore(ratings[name], levels, name) * weights[name];
  }, 0);
}

// The highest and lowest possible scores, so a score can be read as a share of the range
function wsesRange({ weights = WSES_WEIGHTS, levels = WSES_LEVELS } = {}) {
  const values = Object.values(levels);
  const sum = WSES_PARAMETERS.reduce((s, name) => s + weights[name], 0);
  return { min: Math.min(...values) * sum, max: Math.max(...values) * sum };
}

function rating(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 10) throw new RiskInputError(`${name} must be a whole number from 1 to 10.`);
  return value;
}

function rpn({ severity, occurrence, detection }) {
  return rating(severity, "Severity") * rating(occurrence, "Occurrence") * rating(detection, "Detection");
}

// Highest first; ties keep their original order
function rank(items, score) {
  return items.map((item, index) => ({ item, index, score: score(item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item, score: value }, i) => ({ rank: i + 1, score: value, ...item }));
}

module.exports = { wses, wsesRange, rpn, rank, WSES_WEIGHTS, WSES_LEVELS, WSES_PARAMETERS, RiskInputError };
