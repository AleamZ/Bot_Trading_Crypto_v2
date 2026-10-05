// Regenerates docs/ai/bot-analysis-skill.md from the constants in BotAnalysisSkill.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderBotAnalysisSkillMarkdown } from "../src/application/ai/BotAnalysisSkill.js";

const target = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/ai/bot-analysis-skill.md");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, renderBotAnalysisSkillMarkdown(), "utf8");
console.log(`Wrote ${target}`);
