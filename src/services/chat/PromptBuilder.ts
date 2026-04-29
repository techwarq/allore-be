interface PromptSection {
  header: string;
  body: string;
  critical?: boolean; // renders with CRITICAL marker
}

export class PromptBuilder {
  private sections: PromptSection[] = [];

  add(section: PromptSection): this {
    this.sections.push(section);
    return this;
  }

  addContext(label: string, data: unknown): this {
    return this.add({
      header: label,
      body: JSON.stringify(data, null, 0), // compact — saves tokens
    });
  }

  build(): string {
    return this.sections
      .map(s => {
        const marker = s.critical ? " (CRITICAL)" : "";
        return `## ${s.header}${marker}\n\n${s.body}`;
      })
      .join("\n\n---\n\n");
  }

  estimateTokens(): number {
    // ~4 chars per token — good enough for budget guard
    return Math.ceil(this.build().length / 4);
  }
}
