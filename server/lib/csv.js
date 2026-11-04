// CSV export. Cells that a spreadsheet would run as a formula are neutralised.
function csvCell(value) {
  let text = String(value === null || value === undefined ? "" : value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  return `﻿${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

module.exports = { toCsv };
