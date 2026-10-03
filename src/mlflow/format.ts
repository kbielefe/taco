/** Replace MLflow `{{variable}}` placeholders. Inserted values are not scanned again. */
export function formatPrompt(template: string, variables: Record<string, string> = {}): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, name: string) => {
    const value = variables[name];
    return value === undefined ? match : value;
  });
}
