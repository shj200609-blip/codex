import ts from "typescript";

// Change only one top-level setting. Preserve unrelated settings, comments,
// formatting and authentication storage rather than rebuilding a user profile.
export function updateJsoncSetting(
  source: string,
  key: string,
  value: string,
): string {
  const parsed = ts.parseConfigFileTextToJson("settings.json", source);
  if (parsed.error)
    throw new Error(
      "VS Code settings contain invalid JSONC. No settings were changed.",
    );
  const file = ts.parseJsonText("settings.json", source);
  const expression = (file.statements[0] as ts.ExpressionStatement | undefined)
    ?.expression;
  if (!expression || !ts.isObjectLiteralExpression(expression))
    throw new Error("Expected a settings JSON object.");
  const matching = expression.properties.filter(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isStringLiteral(property.name) &&
      property.name.text === key,
  );
  if (matching.length > 1)
    throw new Error(`Duplicate setting ${key}; no settings were changed.`);
  if (matching.length) {
    const property = matching[0] as ts.PropertyAssignment;
    return (
      source.slice(0, property.initializer.getStart(file)) +
      JSON.stringify(value) +
      source.slice(property.initializer.end)
    );
  }
  const last = expression.properties.at(-1);
  const end = expression.end - 1;
  let text = source;
  let insertion = end;
  if (last) {
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      true,
      ts.LanguageVariant.Standard,
      source.slice(last.end, end),
    );
    const hasComma = scanner.scan() === ts.SyntaxKind.CommaToken;
    if (!hasComma) {
      text = source.slice(0, last.end) + "," + source.slice(last.end);
      insertion++;
    }
  }
  return (
    text.slice(0, insertion) +
    `\n  ${JSON.stringify(key)}: ${JSON.stringify(value)}\n` +
    text.slice(insertion)
  );
}
