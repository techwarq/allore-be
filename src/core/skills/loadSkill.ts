// Minimal frontmatter parser for skill/.md files (no yaml dependency — Workers
// bundle size stays small; the frontmatter here is only ever flat strings or a
// single `|` block scalar, which this covers).
export interface Skill {
  whenToUse?: string;
  routingNotes?: string;
  body: string;
}

export function parseSkill(raw: string): Skill {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { body: raw.trim() };

  const [, frontmatter, body] = match;
  const skill: Skill = { body: body.trim() };
  const lines = frontmatter.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\w+):\s*(\|)?\s*(.*)$/);
    if (!m) continue;
    const [, key, isBlock, inline] = m;

    if (isBlock) {
      const blockLines: string[] = [];
      while (i + 1 < lines.length && (lines[i + 1].startsWith("  ") || lines[i + 1].trim() === "")) {
        blockLines.push(lines[++i].replace(/^  /, ""));
      }
      (skill as any)[key] = blockLines.join("\n").trim();
    } else {
      (skill as any)[key] = inline.trim();
    }
  }

  return skill;
}
