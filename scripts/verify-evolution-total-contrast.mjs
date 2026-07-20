#!/usr/bin/env node

import { readFileSync } from "node:fs";

const css = readFileSync("src/app/globals.css", "utf8");
const foreground = "#f7faff";
const backgrounds = ["#1e2c44", "#2a3b58"];

function rgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function luminance(hex) {
  const channels = rgb(hex).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first, second) {
  const [bright, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
}

const failures = [];
for (const background of backgrounds) {
  const ratio = contrast(foreground, background);
  if (ratio < 4.5) failures.push(`${foreground} sobre ${background}: ${ratio.toFixed(2)}:1`);
}

if (!css.includes(".evolution-matrix tfoot td > *") || !css.includes(".customer-summary tfoot td > *")) {
  failures.push("Falta la regla explícita que impide que strong/small hereden colores oscuros globales.");
}

if (failures.length) {
  console.error(`EVOLUTION TOTAL CONTRAST: FAIL\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`EVOLUTION TOTAL CONTRAST: PASS — contraste mínimo ${Math.min(...backgrounds.map((background) => contrast(foreground, background))).toFixed(2)}:1 (AA >= 4.5:1).`);
}
